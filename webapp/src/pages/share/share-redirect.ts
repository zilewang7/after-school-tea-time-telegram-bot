import { match, P } from 'ts-pattern';
import type { ChatSummary, PublicShare } from '../../api';
import { conversationPath, replyPath, replyWidgetFocusPath } from '../../routing/paths';

/**
 * Where a viewer who may open the shared chat goes: the panel's own reply or
 * conversation page, whose actions keep following the existing access rules.
 * A reply that has a widget carries the focus marker, so the reader lands on
 * the card instead of the top of the reply. null = stay on the read-only view.
 * Every chat in `me.chats` is one the viewer can open, so membership is the check.
 */
export const shareRedirectPathOf = (share: PublicShare, chats: readonly ChatSummary[]): string | null => {
    const viewerChat = chats.find((candidate) => candidate.chatId === share.chatId);
    if (viewerChat === undefined) return null;
    return match(share)
        .with({ kind: 'reply', reply: P.nonNullable }, ({ reply }) =>
            reply.widget === null
                ? replyPath(share.chatId, reply.firstMessageId)
                : replyWidgetFocusPath(share.chatId, reply.firstMessageId)
        )
        .with({ kind: 'conversation', conversation: P.nonNullable }, ({ conversation }) =>
            conversationPath(share.chatId, conversation.rootId)
        )
        .otherwise(() => null);
};
