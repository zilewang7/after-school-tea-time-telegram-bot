/**
 * In-memory page state kept per history entry, so a list that Back returns to
 * renders its rows (every page loaded so far) in the very first frame, and
 * <ScrollRestoration> can put the scroll position back.
 *
 * Key by `useLocation().key` plus a name for the list: Back returns to the
 * same key, while a tab switch (a replace) gets a new key and loads fresh.
 */
export interface SnapshotStore<T> {
    read(key: string): T | null;
    write(key: string, value: T): void;
    /** Rewrites every stored value, e.g. to apply an edit made on a detail page */
    updateAll(updater: (value: T) => T): void;
    clear(): void;
}

/** Keeps the `capacity` most recently written values */
export const createSnapshotStore = <T>(capacity: number): SnapshotStore<T> => {
    const values = new Map<string, T>();
    return {
        read: (key) => values.get(key) ?? null,
        write: (key, value) => {
            // Re-inserted, so iteration order is oldest write first
            values.delete(key);
            values.set(key, value);
            for (const oldestKey of values.keys()) {
                if (values.size <= capacity) break;
                values.delete(oldestKey);
            }
        },
        updateAll: (updater) => {
            for (const [key, value] of values) values.set(key, updater(value));
        },
        clear: () => values.clear(),
    };
};
