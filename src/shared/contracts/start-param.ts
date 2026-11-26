/**
 * Pure Telegram Mini App `startapp` / `start_param` codec shared by all Direct
 * Link builders and the panel auth parser.
 *
 * Formats:
 * - `c<chatId>`                   open a chat
 * - `c<chatId>_<rootId>`          open one conversation of a chat
 * - `i<issueId>`                  open an issue
 * - `r<chatId>_<firstMessageId>`  open one bot reply
 * - `s<token>`                    open a public share
 * - `t<token>`                    open a public long-CoT thinking view
 *
 * Pure TypeScript with zero Node/DOM/external dependencies.
 */

export type StartParamTarget =
    | { kind: 'chat'; chatId: number }
    | { kind: 'conversation'; chatId: number; rootId: number }
    | { kind: 'issue'; issueId: number }
    | { kind: 'reply'; chatId: number; firstMessageId: number }
    | { kind: 'share'; token: string }
    | { kind: 'thinking'; token: string };

/** Base64url token accepted in share (`s<token>`) and thinking (`t<token>`) start params */
export const START_PARAM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const isStartParamToken = (token: string): boolean => START_PARAM_TOKEN_PATTERN.test(token);

const CHAT_PATTERN = /^c(-?\d{1,20})$/;
/** Tried before the chat form: a two-part id is never a chat id */
const CONVERSATION_PATTERN = /^c(-?\d{1,20})_(\d{1,12})$/;
const ISSUE_PATTERN = /^i(\d{1,10})$/;
/** Group ids are negative and `-` is allowed in a start_param; reply ids are positive */
const REPLY_PATTERN = /^r(-?\d{1,20})_(\d{1,12})$/;
const SHARE_PATTERN = /^s([A-Za-z0-9_-]{16,64})$/;
const THINKING_PATTERN = /^t([A-Za-z0-9_-]{16,64})$/;

/** A safe integer from a digit string; null when it overflows */
const safeIntegerOf = (digits: string): number | null => {
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : null;
};

/** Encode a structured target into the `startapp` query value */
export const encodeStartParam = (target: StartParamTarget): string => {
    switch (target.kind) {
        case 'chat':
            return `c${target.chatId}`;
        case 'conversation':
            return `c${target.chatId}_${target.rootId}`;
        case 'issue':
            return `i${target.issueId}`;
        case 'reply':
            return `r${target.chatId}_${target.firstMessageId}`;
        case 'share':
            return `s${target.token}`;
        case 'thinking':
            return `t${target.token}`;
    }
};

/** Decode a raw `start_param` string; unknown or malformed values return null */
export const decodeStartParam = (raw: string | null | undefined): StartParamTarget | null => {
    if (raw === null || raw === undefined) return null;
    const conversationMatch = CONVERSATION_PATTERN.exec(raw);
    if (conversationMatch?.[1] !== undefined && conversationMatch[2] !== undefined) {
        const chatId = safeIntegerOf(conversationMatch[1]);
        const rootId = safeIntegerOf(conversationMatch[2]);
        if (chatId === null || chatId === 0) return null;
        if (rootId === null || rootId < 1) return null;
        return { kind: 'conversation', chatId, rootId };
    }
    const chatMatch = CHAT_PATTERN.exec(raw);
    if (chatMatch?.[1] !== undefined) {
        const chatId = safeIntegerOf(chatMatch[1]);
        return chatId === null || chatId === 0 ? null : { kind: 'chat', chatId };
    }
    const issueMatch = ISSUE_PATTERN.exec(raw);
    if (issueMatch?.[1] !== undefined) {
        const issueId = safeIntegerOf(issueMatch[1]);
        return issueId === null ? null : { kind: 'issue', issueId };
    }
    const replyMatch = REPLY_PATTERN.exec(raw);
    if (replyMatch?.[1] !== undefined && replyMatch[2] !== undefined) {
        const chatId = safeIntegerOf(replyMatch[1]);
        const firstMessageId = safeIntegerOf(replyMatch[2]);
        if (chatId === null || chatId === 0) return null;
        if (firstMessageId === null || firstMessageId < 1) return null;
        return { kind: 'reply', chatId, firstMessageId };
    }
    const shareMatch = SHARE_PATTERN.exec(raw);
    if (shareMatch?.[1] !== undefined) return { kind: 'share', token: shareMatch[1] };
    const thinkingMatch = THINKING_PATTERN.exec(raw);
    if (thinkingMatch?.[1] !== undefined) return { kind: 'thinking', token: thinkingMatch[1] };
    return null;
};
