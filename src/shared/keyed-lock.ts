/**
 * Per-key mutual exclusion for read-modify-write sequences.
 *
 * Node is single-threaded but not single-tasked: two handlers that read a row,
 * mutate it and save it back can interleave across their awaits and silently
 * lose one of the two updates. Running such a sequence under a key (e.g.
 * "chatId:messageId") serializes only the sequences that touch the same row.
 */

/** Runs tasks sharing a key one after another; different keys stay parallel. */
export interface KeyedLock {
    runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;
}

export const createKeyedLock = (): KeyedLock => {
    const chains = new Map<string, Promise<void>>();

    const runExclusive = <T>(key: string, task: () => Promise<T>): Promise<T> => {
        const previous = chains.get(key) ?? Promise.resolve();
        // Run after the previous holder settled, whichever way it settled
        const result = previous.then(task, task);
        // The chain itself must never reject, or every later waiter inherits it
        const chained = result.then(
            () => undefined,
            () => undefined
        );
        chains.set(key, chained);
        void chained.then(() => {
            // Drop the key once this task was the last one queued on it
            if (chains.get(key) === chained) chains.delete(key);
        });
        return result;
    };

    return { runExclusive };
};
