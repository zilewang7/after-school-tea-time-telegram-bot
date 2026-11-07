/**
 * Where each message of a conversation hangs in the panel's tree: under the
 * message it replies to (`reply`), under the message whose `/chat` (or panel
 * splice) brought it in (`link`), or — for a message pulled in only because
 * something in the context replies to it — under the first message replying
 * to it (`reply-target`, the reverse direction). The root, and anything whose
 * parent is not in the tree, has neither.
 */
import { getLinkedMessageIds, type ContextMessage } from '../../db/queries/context-queries.js';

export type TreeEdge = 'reply' | 'link' | 'reply-target';

export interface TreePlacement {
    parentId: number | null;
    edge: TreeEdge | null;
}

const UNPLACED: TreePlacement = { parentId: null, edge: null };

/** linked message → the smallest source in the tree that links it */
const linkSourcesOf = async (chatId: number, ids: readonly number[]): Promise<Map<number, number>> => {
    const linkedFrom = new Map<number, number>();
    const bySource = await getLinkedMessageIds(chatId, [...ids]);
    const sources = [...bySource.keys()].sort((a, b) => a - b);
    for (const source of sources) {
        for (const linked of bySource.get(source) ?? []) {
            if (!linkedFrom.has(linked)) linkedFrom.set(linked, source);
        }
    }
    return linkedFrom;
};

/** replied-to id → the oldest message of the tree replying to it */
const firstRepliersOf = (messages: readonly ContextMessage[]): Map<number, number> => {
    const firstReplier = new Map<number, number>();
    const byAge = [...messages].sort((a, b) => a.messageId - b.messageId);
    for (const message of byAge) {
        if (message.replyToId !== null && !firstReplier.has(message.replyToId)) {
            firstReplier.set(message.replyToId, message.messageId);
        }
    }
    return firstReplier;
};

/** Whether following parents up from `messageId` comes back to it */
const leadsBackTo = (messageId: number, placements: ReadonlyMap<number, TreePlacement>): boolean => {
    const seen = new Set<number>([messageId]);
    let current = placements.get(messageId)?.parentId ?? null;
    while (current !== null) {
        if (seen.has(current)) return current === messageId;
        seen.add(current);
        current = placements.get(current)?.parentId ?? null;
    }
    return false;
};

/**
 * One placement per message, keyed by message id. A reply edge wins over a
 * link edge; a reply target never parents a reply (it hangs under its first
 * replier instead). Whatever would still close a loop (links can attach an
 * ancestor) is left unplaced, so the result is always a forest.
 */
export const placeTreeMessages = async (
    chatId: number,
    rootId: number,
    messages: readonly ContextMessage[],
    replyTargetIds: ReadonlySet<number>
): Promise<Map<number, TreePlacement>> => {
    const treeIds = new Set(
        messages.map((message) => message.messageId).filter((messageId) => !replyTargetIds.has(messageId))
    );
    const linkedFrom = await linkSourcesOf(chatId, [...treeIds]);
    const firstReplier = firstRepliersOf(messages);

    const placements = new Map<number, TreePlacement>();
    for (const message of messages) {
        const { messageId, replyToId } = message;
        const linkSource = linkedFrom.get(messageId);
        if (messageId === rootId) {
            placements.set(messageId, UNPLACED);
        } else if (replyTargetIds.has(messageId)) {
            placements.set(messageId, { parentId: firstReplier.get(messageId) ?? null, edge: 'reply-target' });
        } else if (replyToId !== null && treeIds.has(replyToId)) {
            placements.set(messageId, { parentId: replyToId, edge: 'reply' });
        } else if (linkSource !== undefined) {
            placements.set(messageId, { parentId: linkSource, edge: 'link' });
        } else {
            placements.set(messageId, UNPLACED);
        }
    }
    for (const messageId of placements.keys()) {
        if (leadsBackTo(messageId, placements)) placements.set(messageId, UNPLACED);
    }
    return placements;
};
