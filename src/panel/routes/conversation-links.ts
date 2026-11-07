/**
 * POST /api/chats/:chatId/conversations/:rootId/links { links: string[] } —
 * members only: splice other conversations of this chat into this one, the
 * stored half of `/chat <link>` (attachLinkedConversations and
 * describeLinkProblems reused as is). The edge's source is the conversation's
 * root, as there is no command message; like `/chat`, it cannot be undone.
 *
 * Before reusing it: `rootId` must be a root (no orphan edges), 1–20 links
 * that are trimmed and parsed one by one (unparseable ones are reported in
 * `invalid`; all of them unparseable is a 400), and a `t.me/<username>/N`
 * link that does not match the stored username refreshes it with getChat
 * first (`/chat` compares against the live chat). Audited only when something
 * was attached.
 */
import type { Hono } from 'hono';
import { chatAuditScope, writeSettingsAudit } from '../../db/queries/settings-audit.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import { attachLinkedConversations, describeLinkProblems } from '../../reply/commands/chat-command-link.js';
import { parseTelegramMessageLink, type TelegramMessageLink } from '../../reply/commands/telegram-message-link.js';
import { requireChatAccess } from '../access/require-access.js';
import type { ChatNameInfo, ChatNameLookup } from '../chat-names.js';
import { requireAuth, type PanelEnv } from '../context.js';
import type { JsonRecord } from '../json.js';
import { checkBodyKeys, invalid, parseChatId, readJsonObject } from '../request.js';
import type { ConversationRouteDeps } from './conversation-deps.js';
import { parseMessageIdParam, requireConversationRoot, requireMember } from './conversation-params.js';

const LINKS_KEY = 'links';
const ALLOWED_KEYS: ReadonlySet<string> = new Set([LINKS_KEY]);
const MAX_LINKS = 20;
/** Longer than any real message link; never parsed */
const MAX_LINK_LENGTH = 512;
/** How much of an unparseable entry is echoed back in `invalid` */
const INVALID_ECHO_CHARS = 200;
const CHAT_LOOKUP_TIMEOUT_MS = 5000;

export interface LinkSpliceView {
    attachedRoots: number;
    foreign: number[];
    missing: number[];
    alreadyInTree: number[];
    /** Entries that are not message links, trimmed (and cut at 200 characters) */
    invalid: string[];
    /** What to tell the user about the links that did not go in; null when all did */
    notice: string | null;
}

interface ParsedLinks {
    links: TelegramMessageLink[];
    invalid: string[];
}

const parseLinks = (body: JsonRecord): ParsedLinks => {
    checkBodyKeys(body, ALLOWED_KEYS, [LINKS_KEY]);
    const raw = body[LINKS_KEY];
    if (!Array.isArray(raw)) throw invalid('links 必须是字符串数组');
    if (raw.length < 1 || raw.length > MAX_LINKS) throw invalid(`links 需要 1 到 ${MAX_LINKS} 项`);

    const parsed: ParsedLinks = { links: [], invalid: [] };
    for (const item of raw) {
        if (typeof item !== 'string') throw invalid('links 必须是字符串数组');
        const trimmed = item.trim();
        const link = trimmed.length <= MAX_LINK_LENGTH ? parseTelegramMessageLink(trimmed) : null;
        if (link === null) parsed.invalid.push(Array.from(trimmed).slice(0, INVALID_ECHO_CHARS).join(''));
        else parsed.links.push(link);
    }
    if (parsed.links.length === 0) throw invalid('没有可识别的消息链接');
    return parsed;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lookupWithDeadline = async (lookup: ChatNameLookup, chatId: number): Promise<ChatNameInfo> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer within ${CHAT_LOOKUP_TIMEOUT_MS}ms`));
        }, CHAT_LOOKUP_TIMEOUT_MS);
    });
    try {
        return await Promise.race([lookup(chatId, controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * The chat's username to judge the links by: the stored one, unless a
 * username link disagrees with it — then getChat's (the stored one when that
 * fails). The registry itself is left to autoSave.
 */
const usernameForLinks = async (
    chat: ChatRow,
    links: readonly TelegramMessageLink[],
    lookup: ChatNameLookup | null
): Promise<string | null> => {
    const stored = chat.username?.toLowerCase() ?? null;
    const disagrees = links.some((link) => link.chatRef.type === 'username' && link.chatRef.username !== stored);
    if (!disagrees || lookup === null) return chat.username;
    try {
        return (await lookupWithDeadline(lookup, chat.chatId)).username ?? null;
    } catch (error) {
        console.warn(`[panel] getChat ${chat.chatId} failed, judging links by the stored username: ${describeError(error)}`);
        return chat.username;
    }
};

const invalidNotice = (count: number): string | null =>
    count > 0 ? `有 ${count} 条不是有效的消息链接，已跳过` : null;

export const registerConversationLinksRoute = (app: Hono<PanelEnv>, deps: ConversationRouteDeps): void => {
    app.post('/api/chats/:chatId/conversations/:rootId/links', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const granted = await requireChatAccess(auth, chatId);
        requireMember(granted);

        const rootId = parseMessageIdParam(context.req.param('rootId'), 'rootId');
        const parsed = parseLinks(await readJsonObject(context));
        await requireConversationRoot(chatId, rootId);

        const username = await usernameForLinks(granted.chat, parsed.links, deps.chatLookup);
        const result = await attachLinkedConversations(
            { id: chatId, ...(username !== null ? { username } : {}) },
            rootId,
            rootId,
            parsed.links
        );
        if (result.attachedRoots > 0) {
            await writeSettingsAudit({
                actorId: auth.user.id,
                scope: chatAuditScope(chatId),
                key: 'link',
                oldValue: null,
                newValue: JSON.stringify({
                    rootId,
                    linkMessageIds: parsed.links.map((link) => link.messageId),
                    attachedRoots: result.attachedRoots,
                }),
            });
        }

        const notices = [describeLinkProblems(result), invalidNotice(parsed.invalid.length)].filter(
            (line): line is string => line !== null
        );
        const view: LinkSpliceView = {
            attachedRoots: result.attachedRoots,
            foreign: result.foreign,
            missing: result.missing,
            alreadyInTree: result.alreadyInTree,
            invalid: parsed.invalid,
            notice: notices.length > 0 ? notices.join('\n') : null,
        };
        return context.json(view);
    });
};
