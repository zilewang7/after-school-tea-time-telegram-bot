/**
 * The signed `start_param` of initData (`?startapp=` of a Direct Link):
 * `c<chatId>` opens a chat, `c<chatId>_<rootId>` one conversation of it
 * (`/panel`'s "打开这条会话" button), `i<issueId>` an issue,
 * `r<chatId>_<firstMessageId>` one bot reply (the group widget fallback's deep
 * link, design §5.10), `s<token>` a public share (the share page's Mini App
 * button), and `t<token>` a public long-CoT view (the thinking link's deep
 * link, design §6.2). Anything else, empty included, is ignored.
 *
 * It is only a hint for where to land, never a permission: a share or thinking
 * token is read through its public API, and whatever a chat target names still
 * goes through resolveChatAccess.
 */
import { match } from 'ts-pattern';
import { decodeStartParam, encodeStartParam, type StartParamTarget } from '../../shared/contracts/start-param.js';

export { decodeStartParam, encodeStartParam, type StartParamTarget };

/** Alias for `decodeStartParam` kept for existing panel callers */
export const parseStartParam = decodeStartParam;

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
        .with({ kind: 'conversation' }, (conversationTarget) => Promise.resolve(conversationTarget.chatId))
        .with({ kind: 'issue' }, (issueTarget) => lookupIssueChatId(issueTarget.issueId))
        .with({ kind: 'reply' }, (replyTarget) => Promise.resolve(replyTarget.chatId))
        // A public share or thinking link carries no chat hint: its token is the permission
        .with({ kind: 'share' }, () => Promise.resolve(null))
        .with({ kind: 'thinking' }, () => Promise.resolve(null))
        .exhaustive();
};
