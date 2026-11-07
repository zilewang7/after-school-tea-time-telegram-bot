/**
 * Where the panel should land, from the signed start_param: a chat or an
 * issue, with the requester's access to the chat behind it. Only a hint: the
 * target's own endpoint checks access again.
 */
import { match } from 'ts-pattern';
import { MembershipUnavailableError, type ChatAccessResolver } from '../access/chat-access.js';
import type { StartParamTarget } from '../auth/start-param.js';
import type { ChatAccess } from '../types.js';

export type StartTargetView =
    | { kind: 'chat'; chatId: number; access: ChatAccess }
    | { kind: 'issue'; chatId: number; issueId: number; access: ChatAccess };

/** A rate-limited lookup reads as no access here; the chat's own endpoint answers 503 */
const accessOf = async (resolver: ChatAccessResolver, chatId: number): Promise<ChatAccess> => {
    try {
        return await resolver.resolve(chatId);
    } catch (error) {
        if (error instanceof MembershipUnavailableError) return 'none';
        throw error;
    }
};

/**
 * `hintChatId` is the chat the target points into (resolveHintChatId); an
 * issue without one (missing, or not tied to a chat) yields no target.
 */
export const buildStartTarget = async (
    target: StartParamTarget | null,
    hintChatId: number | null,
    resolver: ChatAccessResolver
): Promise<StartTargetView | null> => {
    if (target === null || hintChatId === null) return null;
    const access = await accessOf(resolver, hintChatId);
    return match(target)
        .returnType<StartTargetView>()
        .with({ kind: 'chat' }, () => ({ kind: 'chat', chatId: hintChatId, access }))
        .with({ kind: 'issue' }, (issueTarget) => ({
            kind: 'issue',
            chatId: hintChatId,
            issueId: issueTarget.issueId,
            access,
        }))
        .exhaustive();
};
