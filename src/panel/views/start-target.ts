/**
 * Where the panel should land, from the signed start_param: a chat or an
 * issue, with the requester's access to the chat behind it. Only a hint: the
 * target's own endpoint checks access again.
 *
 * It never tells a requester more than their own link says: an issue whose
 * chat they cannot open reads exactly like a missing one (no chatId, `none`),
 * so `i<N>` links cannot map issues to chats.
 */
import { match } from 'ts-pattern';
import { MembershipUnavailableError, type ChatAccessResolver } from '../access/chat-access.js';
import type { StartParamTarget } from '../auth/start-param.js';
import type { ChatAccess } from '../types.js';

/**
 * `unavailable`: Telegram rate-limited the membership lookup. The chat's own
 * endpoint answers 503 for the same reason and the panel retries there.
 */
export type StartTargetAccess = ChatAccess | 'unavailable';

export type StartTargetView =
    | { kind: 'chat'; chatId: number; access: StartTargetAccess }
    | { kind: 'issue'; chatId: number | null; issueId: number; access: StartTargetAccess };

const accessOf = async (resolver: ChatAccessResolver, chatId: number): Promise<StartTargetAccess> => {
    try {
        return await resolver.resolve(chatId);
    } catch (error) {
        if (error instanceof MembershipUnavailableError) return 'unavailable';
        throw error;
    }
};

const chatTargetOf = async (chatId: number, resolver: ChatAccessResolver): Promise<StartTargetView> => ({
    kind: 'chat',
    chatId,
    access: await accessOf(resolver, chatId),
});

/** Only a requester who can open the issue's chat learns which chat that is */
const issueTargetOf = async (
    issueId: number,
    issueChatId: number | null,
    resolver: ChatAccessResolver
): Promise<StartTargetView> => {
    const hidden: StartTargetView = { kind: 'issue', chatId: null, issueId, access: 'none' };
    if (issueChatId === null) return hidden;
    const access = await accessOf(resolver, issueChatId);
    const canOpen = access === 'member' || access === 'observer';
    return canOpen ? { kind: 'issue', chatId: issueChatId, issueId, access } : hidden;
};

/** `hintChatId` is the chat the target points into (resolveHintChatId): the chat itself, or the issue's chat */
export const buildStartTarget = (
    target: StartParamTarget | null,
    hintChatId: number | null,
    resolver: ChatAccessResolver
): Promise<StartTargetView | null> => {
    if (target === null) return Promise.resolve(null);
    return match(target)
        .returnType<Promise<StartTargetView>>()
        .with({ kind: 'chat' }, (chatTarget) => chatTargetOf(chatTarget.chatId, resolver))
        .with({ kind: 'issue' }, (issueTarget) => issueTargetOf(issueTarget.issueId, hintChatId, resolver))
        .exhaustive();
};
