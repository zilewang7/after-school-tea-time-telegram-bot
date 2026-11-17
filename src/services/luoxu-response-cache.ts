/**
 * Process-local TTL/LRU cache for luoxu's read endpoints.
 *
 * luoxu keeps no response cache of its own: every `/search`, `/messages`,
 * `/names`, `/message-images` and `/stats` request either queries PostgreSQL or
 * walks MTProto. A reply often repeats a read (a retried tool call, the same
 * page fetched again while the model thinks), so the second read inside a short
 * window is served from memory here. Rejections are never remembered: a failed
 * request rejects its callers and leaves no entry, so the next call retries.
 *
 * k-on is a single process, so there is no cross-process invalidation; entries
 * expire on time only. `LUOXU_CACHE=0` disables both this cache and the archive
 * image byte cache (the value is read per call so a test can flip it).
 *
 * A hit never logs: one reply could hit the cache dozens of times.
 */

/** One entry: the loader's promise and when it stops being fresh */
interface CacheEntry {
    readonly expiresAt: number;
    /** Erased because one namespace holds responses of many types */
    readonly value: Promise<unknown>;
}

export interface LuoxuResponseCache {
    /**
     * Read `key` of `namespace` from the cache, or run `load` once and remember
     * its promise until `ttlMs` passes. Concurrent callers of one key share the
     * in-flight load. At most `maxEntries` keys are kept per namespace, least
     * recently used first out.
     */
    readonly cachedJson: <T>(
        namespace: string,
        key: string,
        ttlMs: number,
        maxEntries: number,
        load: () => Promise<T>
    ) => Promise<T>;
    /** Forget one namespace, or every namespace when called without one */
    readonly clear: (namespace?: string) => void;
}

/** False when the kill switch turns every luoxu read cache off */
export const isLuoxuCacheEnabled = (): boolean => process.env.LUOXU_CACHE !== '0';

/**
 * A namespace map cannot carry a type parameter per key, so an entry is stored
 * with its promise erased to `unknown`. That promise was produced by the loader
 * given for the same namespace and key, so it resolves to the caller's T; this
 * guard states that fact for the compiler (the repository prefers a type guard
 * over an `as` cast). It is the only unchecked step of the cache.
 */
const isCachedValueOf = <T>(_candidate: unknown): _candidate is T => true;

/** One cache instance; the clock is injectable so offline cases can move time */
export const createLuoxuResponseCache = (clock: () => number): LuoxuResponseCache => {
    const namespaces = new Map<string, Map<string, CacheEntry>>();

    const storeOf = (namespace: string): Map<string, CacheEntry> => {
        const existing = namespaces.get(namespace);
        if (existing !== undefined) return existing;
        const created = new Map<string, CacheEntry>();
        namespaces.set(namespace, created);
        return created;
    };

    const cachedJson = <T>(
        namespace: string,
        key: string,
        ttlMs: number,
        maxEntries: number,
        load: () => Promise<T>
    ): Promise<T> => {
        if (!isLuoxuCacheEnabled()) return load();

        const store = storeOf(namespace);
        const now = clock();
        const cached = store.get(key);
        if (cached !== undefined) {
            if (cached.expiresAt > now) {
                // LRU: a hit becomes the newest entry (Map keeps insertion order)
                store.delete(key);
                store.set(key, cached);
                return cached.value.then((value) => {
                    if (isCachedValueOf<T>(value)) return value;
                    throw new Error(`luoxu cache: an unexpected value was stored for ${namespace}`);
                });
            }
            // Expired: the fresh load below replaces it
            store.delete(key);
        }

        const value = load();
        const entry: CacheEntry = { expiresAt: now + ttlMs, value };
        // A failure must not be remembered for the whole TTL
        value.catch(() => {
            if (store.get(key) === entry) store.delete(key);
        });
        // Evict the least recently used entries before inserting the new one
        while (store.size >= maxEntries) {
            const oldest = store.keys().next();
            if (oldest.done) break;
            store.delete(oldest.value);
        }
        store.set(key, entry);
        return value;
    };

    const clear = (namespace?: string): void => {
        if (namespace === undefined) namespaces.clear();
        else namespaces.delete(namespace);
    };

    return { cachedJson, clear };
};

/** The cache every luoxu read shares, using the process clock */
const defaultLuoxuResponseCache = createLuoxuResponseCache(() => Date.now());

/** Read through the shared cache (see `createLuoxuResponseCache` for the contract) */
export const cachedLuoxuJson = defaultLuoxuResponseCache.cachedJson;

/** Test/operations hook: forget cached responses (one namespace, or everything) */
export const clearLuoxuResponseCache = defaultLuoxuResponseCache.clear;
