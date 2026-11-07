/**
 * The group notice of an issue a person filed from the control panel.
 *
 * Called by the panel's POST /api/issues only, fire-and-forget once it has
 * answered 201 — never from createHarnessIssue, so the model's own issues
 * stay invisible to the chat. Sent only when all of these hold:
 * - the issue was filed by a person (source 'user');
 * - it is filed on a chat, and that chat is a group or supergroup (a negative
 *   id and a registry row saying so): private chats never get one, so the
 *   owner is never messaged privately;
 * - the chat passes isChatAllowed (the test instance's isolation guard).
 * A paused group still gets it: a notice is not a reply.
 *
 * The notice is an independent message (no reply_parameters), built as
 * entities so the user's title is never parsed as markup, without link
 * preview. It is not stored in bot_responses or telegram_messages. Nothing
 * here throws: a failure is logged and the issue stays filed.
 */
import type { Api } from 'grammy';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import { isChatAllowed } from '../config/instance.js';
import { findChat } from '../db/queries/panel-registry.js';
import { formatUserDisplayName, type UserNameParts } from '../shared/user-display-name.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { boldText, linkText, plainText } from '../telegram/formatters/entity-text.js';
import type { HarnessIssueRecord } from './harness-issue-service.js';

/** BotFather short name of the Mini App when WEBAPP_BOT_SHORT_NAME is unset (as /panel) */
const DEFAULT_SHORT_NAME = 'panel';

const VIEW_IN_PANEL_LABEL = '在面板中查看';

/** What happened to one notice; everything but `sent` and `failed` is a deliberate skip */
export type IssueNoticeOutcome =
    | 'sent'
    | 'not_filed_by_user'
    | 'no_chat'
    | 'private_chat'
    | 'chat_not_allowed'
    | 'not_a_group'
    | 'no_panel_link'
    | 'failed';

/** The Direct Link that opens the panel on this issue; null without a bot username */
export const issuePanelLink = (issueId: number): string | null => {
    const botUserName = process.env.BOT_USER_NAME?.trim();
    if (!botUserName) return null;
    const shortName = process.env.WEBAPP_BOT_SHORT_NAME?.trim() || DEFAULT_SHORT_NAME;
    return `https://t.me/${botUserName}/${shortName}?startapp=i${issueId}`;
};

/**
 * 📌 <first last> 通过控制面板提交了 issue #<id>（<kind>）：<title>
 * 在面板中查看
 *
 * The name is plain text, never an @username: it must not mention anyone.
 */
export const renderIssueNotice = (
    record: Pick<HarnessIssueRecord, 'id' | 'kind' | 'title'>,
    user: UserNameParts,
    link: string
): RenderedMessage =>
    concatMessages(
        plainText('📌 '),
        plainText(formatUserDisplayName(user)),
        plainText(' 通过控制面板提交了 issue '),
        boldText(`#${record.id}`),
        plainText(`（${record.kind}）：`),
        plainText(record.title),
        plainText('\n'),
        linkText(VIEW_IN_PANEL_LABEL, link)
    );

type SkipReason = Exclude<IssueNoticeOutcome, 'sent' | 'failed'>;

type NoticeTarget = { kind: 'skip'; reason: SkipReason } | { kind: 'group'; chatId: number; link: string };

const skip = (reason: SkipReason): NoticeTarget => ({ kind: 'skip', reason });

/** The group to tell and the link to give it, or why there is none */
const noticeTargetOf = async (record: HarnessIssueRecord): Promise<NoticeTarget> => {
    if (record.source !== 'user') return skip('not_filed_by_user');
    const chatId = record.chatId;
    if (chatId === null) return skip('no_chat');
    if (chatId > 0) return skip('private_chat');
    if (!isChatAllowed(chatId)) return skip('chat_not_allowed');
    const chat = await findChat(chatId);
    if (chat === null || (chat.type !== 'group' && chat.type !== 'supergroup')) return skip('not_a_group');
    const link = issuePanelLink(record.id);
    if (link === null) return skip('no_panel_link');
    return { kind: 'group', chatId, link };
};

const sendNotice = async (
    api: Api,
    target: { chatId: number; link: string },
    record: HarnessIssueRecord,
    user: UserNameParts
): Promise<void> => {
    const notice = renderIssueNotice(record, user, target.link);
    await runApiCall(target.chatId, () =>
        api.sendMessage(target.chatId, notice.text, {
            entities: toApiEntities(notice.entities),
            link_preview_options: { is_disabled: true },
        })
    );
    console.log(`[harness-issue] chat ${target.chatId} told about #${record.id}`);
};

/**
 * Tell the group a person filed `record` there, if it qualifies (see the file
 * header). `api` is the bot's own Api (autoRetry attached). Resolves with
 * what happened; never rejects.
 */
export const notifyGroupOfUserIssue = async (
    api: Api,
    record: HarnessIssueRecord,
    user: UserNameParts
): Promise<IssueNoticeOutcome> => {
    try {
        const target = await noticeTargetOf(record);
        if (target.kind === 'skip') return target.reason;
        await sendNotice(api, target, record, user);
        return 'sent';
    } catch (error) {
        console.error(`[harness-issue] telling chat ${record.chatId} about #${record.id} failed:`, error);
        return 'failed';
    }
};
