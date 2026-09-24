/**
 * Reply-tree root of a message: the identity of "one context".
 *
 * Two trigger messages that resolve to the same root are assembled into the
 * same context (the tree is walked from the root downwards), which is what lets
 * a single reply cover both. Group chats use this to decide whether two
 * near-simultaneous triggers belong to the same context and should merge.
 *
 * The walk follows `replyToId` upwards. Deep threads are common in a busy
 * group (a chain can be dozens of messages long), so every node visited on the
 * way is memoized — the first message of a thread pays the walk, the rest are
 * resolved from the cache without touching the database.
 */
import { getMessage } from '../db/index.js';

/** Never walk further than this, however broken a reply chain looks */
const MAX_ROOT_HOPS = 200;
/** Bounded memo of visited nodes: "chatId:messageId" -> root message id */
const MAX_CACHE_ENTRIES = 1000;

const rootCache = new Map<string, number>();

const cacheKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

const rememberPath = (chatId: number, path: number[], rootId: number): void => {
    for (const messageId of path) {
        if (rootCache.size >= MAX_CACHE_ENTRIES) {
            const oldest = rootCache.keys().next().value;
            if (oldest !== undefined) rootCache.delete(oldest);
        }
        rootCache.set(cacheKey(chatId, messageId), rootId);
    }
};

/** Drop the memo; offline cases re-seed a fresh database per run */
export const clearContextRootCache = (): void => {
    rootCache.clear();
};

/**
 * Root message id of the reply tree `messageId` belongs to. A row that is
 * missing (not stored yet, or deleted) ends the walk — everything above it is
 * unreachable, so the last known message becomes the root.
 */
export const resolveContextRoot = async (
    chatId: number,
    messageId: number
): Promise<number> => {
    const path: number[] = [];
    const seen = new Set<number>();
    let current = messageId;

    const finish = (rootId: number): number => {
        rememberPath(chatId, path, rootId);
        return rootId;
    };

    for (let hop = 0; hop < MAX_ROOT_HOPS; hop++) {
        const cached = rootCache.get(cacheKey(chatId, current));
        if (cached !== undefined) return finish(cached);
        if (seen.has(current)) return finish(current); // cycle: stop at the repeat
        seen.add(current);
        path.push(current);

        const row = await getMessage(chatId, current);
        if (!row || row.replyToId === null) return finish(current);
        current = row.replyToId;
    }

    return finish(path.at(-1) ?? messageId);
};
