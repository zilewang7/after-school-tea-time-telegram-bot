/**
 * The signed `start_param` of initData (`?startapp=` of a Direct Link):
 * `c<chatId>` opens a chat, `i<issueId>` an issue. Anything else, empty
 * included, is ignored.
 *
 * It is only a hint for where to land, never a permission: whatever it names
 * still goes through resolveChatAccess.
 */
import { match } from 'ts-pattern';

export type StartParamTarget = { kind: 'chat'; chatId: number } | { kind: 'issue'; issueId: number };

const CHAT_PATTERN = /^c(-?\d{1,20})$/;
const ISSUE_PATTERN = /^i(\d{1,10})$/;

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
        .exhaustive();
};
