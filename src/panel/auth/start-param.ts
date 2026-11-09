/**
 * The signed `start_param` of initData (`?startapp=` of a Direct Link):
 * `c<chatId>` opens a chat, `i<issueId>` an issue, `r<chatId>_<firstMessageId>`
 * one bot reply (the group widget fallback's deep link, design §5.10), and
 * `s<token>` a public share (the share page's Mini App button). Anything else,
 * empty included, is ignored.
 *
 * It is only a hint for where to land, never a permission: a share token is
 * read through the public share API, and whatever a chat target names still
 * goes through resolveChatAccess.
 */
import { match } from 'ts-pattern';

export type StartParamTarget =
    | { kind: 'chat'; chatId: number }
    | { kind: 'issue'; issueId: number }
    | { kind: 'reply'; chatId: number; firstMessageId: number }
    | { kind: 'share'; token: string };

const CHAT_PATTERN = /^c(-?\d{1,20})$/;
const ISSUE_PATTERN = /^i(\d{1,10})$/;
/** Group ids are negative and `-` is allowed in a start_param; reply ids are positive */
const REPLY_PATTERN = /^r(-?\d{1,20})_(\d{1,12})$/;
/** Share tokens are base64url; the page accepts 16–64 characters */
const SHARE_PATTERN = /^s([A-Za-z0-9_-]{16,64})$/;

/** A safe integer from a digit string; null when it overflows */
const safeIntegerOf = (digits: string): number | null => {
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : null;
};

export const parseStartParam = (raw: string | null | undefined): StartParamTarget | null => {
    if (raw === null || raw === undefined) return null;
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
    return null;
};

/** Where an issue lives: its chatId, null when the issue is missing or has no chat */
export type IssueChatLookup = (issueId: number) => Promise<number | null>;

/** The chat a start target points into; null when there is none */
export const resolveHintChatId = async (
    target: StartParamTarget | null,
    lookupIssueChatId: IssueChatLookup
): Promise<number | null> => {
    if (target === null) return null;
    return match(target)
        .with({ kind: 'chat' }, (chatTarget) => Promise.resolve(chatTarget.chatId))
        .with({ kind: 'issue' }, (issueTarget) => lookupIssueChatId(issueTarget.issueId))
        .with({ kind: 'reply' }, (replyTarget) => Promise.resolve(replyTarget.chatId))
        // A public share carries no chat hint: its token is the permission
        .with({ kind: 'share' }, () => Promise.resolve(null))
        .exhaustive();
};
