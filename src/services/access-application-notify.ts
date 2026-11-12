/**
 * Messages the access flow sends outside a reply: the owner is told about a new
 * application, and the applicant is told the decision (or a revocation).
 *
 * Everything here is fire-and-forget: a failed send is recorded on the
 * application row (`deliveryStatus` / `deliveryError`) and logged, never thrown
 * into the panel route or the command. Sends go through `runApiCall`, so they
 * share the per-chat budget with the streaming editor, and each one is stored as
 * a bot message row so later contexts see it.
 */
import type { Api } from 'grammy';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import { isChatAllowed } from '../config/instance.js';
import { getOwnerUserId } from '../config/owner.js';
import { findChat } from '../db/queries/panel-registry.js';
import { findTelegramUsersByIds } from '../db/queries/user-queries.js';
import { writeBotMessageRow } from '../db/bot-message-row.js';
import { formatUserDisplayName } from '../shared/user-display-name.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { boldText, codeText, linkText, plainText } from '../telegram/formatters/entity-text.js';
import {
    markApplicationDelivery,
    type AccessApplicationRecord,
} from './user-access-service.js';

/** BotFather short name of the Mini App when WEBAPP_BOT_SHORT_NAME is unset (as /panel) */
const DEFAULT_SHORT_NAME = 'panel';

const REVIEW_LINK_LABEL = '打开面板的「准入」页审核';

/** A Direct Link into the Mini App home, where the access tab lives; null without a bot username */
const miniAppLink = (): string | null => {
    const botUserName = process.env.BOT_USER_NAME?.trim();
    if (botUserName) {
        const shortName = process.env.WEBAPP_BOT_SHORT_NAME?.trim() || DEFAULT_SHORT_NAME;
        return `https://t.me/${botUserName}/${shortName}`;
    }
    const publicUrl = process.env.WEBAPP_PUBLIC_URL?.trim();
    return publicUrl ? publicUrl : null;
};

const errorTextOf = (error: unknown): string => {
    if (error instanceof Error) return error.message.slice(0, 500);
    return String(error).slice(0, 500);
};

/** Send one notice, store it as a bot row, and never throw */
const sendStoredNotice = async (
    api: Api,
    chatId: number,
    replyToMessageId: number | null,
    message: RenderedMessage
): Promise<void> => {
    const sent = await runApiCall(chatId, () =>
        api.sendMessage(chatId, message.text, {
            entities: toApiEntities(message.entities),
            link_preview_options: { is_disabled: true },
            ...(replyToMessageId === null
                ? {}
                : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
        })
    );
    await writeBotMessageRow({
        chatId,
        messageId: sent.message_id,
        replyToId: replyToMessageId,
        date: sent.date > 0 ? new Date(sent.date * 1000) : new Date(),
        text: message.text,
        modelParts: null,
        file: null,
        fileMime: null,
    }).catch((error: unknown) => {
        console.error('[access-notify] failed to store the notice row:', error);
    });
};

const applicantLabel = async (userId: number): Promise<string> => {
    const [user] = await findTelegramUsersByIds([userId]);
    if (user === undefined) return `用户 ${userId}`;
    return formatUserDisplayName(user);
};

const sourceChatLabel = async (chatId: number): Promise<string> => {
    if (chatId > 0) return '私聊';
    const chat = await findChat(chatId);
    if (chat === null) return `聊天 ${chatId}`;
    return chat.title ?? `聊天 ${chatId}`;
};

const renderOwnerNotice = (
    record: AccessApplicationRecord,
    name: string,
    chatLabel: string,
    link: string | null
): RenderedMessage =>
    concatMessages(
        plainText('🔔 新准入申请 '),
        boldText(`#${record.id}`),
        plainText(`\n申请人：${name}（id ${record.userId}）`),
        plainText(`\n来源：${chatLabel}`),
        plainText('\n你是谁：'),
        plainText(record.identity),
        plainText('\n你要做什么：'),
        plainText(record.purpose),
        ...(link === null ? [] : [plainText('\n'), linkText(REVIEW_LINK_LABEL, link)])
    );

/**
 * Tell the owner a trial user filed an application. Target: the owner's own
 * private chat (the bot can always reach it). Skips only when the owner is
 * unknown: the inbound ALLOWED_CHAT_IDS gate must not silence an outbound
 * notice to the owner. Never throws.
 */
export const notifyOwnerOfApplication = async (
    api: Api,
    record: AccessApplicationRecord
): Promise<void> => {
    try {
        const ownerId = getOwnerUserId();
        if (ownerId === null) return;
        const [name, chatLabel] = await Promise.all([
            applicantLabel(record.userId),
            sourceChatLabel(record.chatId),
        ]);
        await sendStoredNotice(api, ownerId, null, renderOwnerNotice(record, name, chatLabel, miniAppLink()));
    } catch (error) {
        console.error(`[access-notify] telling the owner about #${record.id} failed:`, error);
    }
};

const renderApproved = (record: AccessApplicationRecord): RenderedMessage =>
    concatMessages(
        plainText('✅ 你的准入申请已通过。\n现在可以使用完整功能（模型、生图等不再受体验限制）。'),
        ...(record.comment === null ? [] : [plainText('\n机主留言：'), plainText(record.comment)])
    );

const renderRejected = (record: AccessApplicationRecord): RenderedMessage =>
    concatMessages(
        plainText('❌ 你的准入申请未通过。'),
        ...(record.comment === null ? [] : [plainText('\n机主留言：'), plainText(record.comment)]),
        plainText('\n补充信息后可以重新申请：在对话里发送 '),
        codeText('/apply'),
        plainText('，或打开 Mini App 的「准入」页。')
    );

/**
 * Tell the applicant the owner's decision, in the chat the application came from
 * (replying to the message that filed it when there is one). The delivery
 * outcome is written back to the application; never throws.
 */
export const notifyApplicantOfDecision = async (
    api: Api,
    record: AccessApplicationRecord
): Promise<void> => {
    try {
        const message = record.status === 'approved' ? renderApproved(record) : renderRejected(record);
        if (!isChatAllowed(record.chatId)) {
            await markApplicationDelivery({
                applicationId: record.id,
                status: 'failed',
                error: '该聊天不在本实例的允许列表中',
            });
            return;
        }
        await sendStoredNotice(api, record.chatId, record.messageId, message);
        await markApplicationDelivery({ applicationId: record.id, status: 'sent', error: null });
        console.log(`[access-notify] decision for #${record.id} delivered to chat ${record.chatId}`);
    } catch (error) {
        console.error(`[access-notify] delivering the decision for #${record.id} failed:`, error);
        await markApplicationDelivery({
            applicationId: record.id,
            status: 'failed',
            error: errorTextOf(error),
        }).catch((updateError: unknown) => {
            console.error('[access-notify] failed to record the delivery failure:', updateError);
        });
    }
};

/**
 * Tell a user the grant was revoked. Target: the chat of the latest approved
 * application, else their private chat. Never throws.
 */
export const notifyApplicantOfRevoke = async (
    api: Api,
    userId: number,
    lastApproved: AccessApplicationRecord | null
): Promise<void> => {
    const chatId = lastApproved?.chatId ?? userId;
    try {
        if (!isChatAllowed(chatId)) return;
        // The grant is what was taken away; a user who is also on the
        // TOOL_CHAT_IDS whitelist (or the owner) keeps their capability, so the
        // text never claims which tier they are in now
        const message = concatMessages(
            plainText('你的完整功能准入已被取消。\n如需再次使用，可以重新提交申请。')
        );
        await sendStoredNotice(api, chatId, lastApproved?.messageId ?? null, message);
    } catch (error) {
        console.error(`[access-notify] telling ${userId} about the revocation failed:`, error);
    }
};
