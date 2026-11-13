/**
 * Live documents of folded GoogleSearch footers (design 2026-1113-1831 §3.7).
 *
 * A folded footer's link message is sent during the final layout, while the
 * reply version is stored only after the media delivery — seconds later at
 * worst. Telegram's preview crawler fetches the page right after the send, so
 * the stored version cannot be the only source (the card would fail to build).
 * The final layout leaves the document here before any message goes out, and
 * the page reads this cache first, falling back to the stored version when the
 * process restarted or the entry expired.
 *
 * In memory only, like the live CoT stream: small, bounded, and only alive
 * while the reply it belongs to is still being delivered.
 */
import type { GoogleSearchDocument } from '../../telegram/formatters/google-search-document.js';

/** What the page shows besides the search content itself */
export interface CachedSearchDocument {
    readonly model: string | null;
    /** ISO time of the delivery; the page's meta line */
    readonly createdAt: string;
    readonly document: GoogleSearchDocument;
}

/** Long enough for a delivery, a restart-free card refresh, and nothing more */
const TTL_MS = 2 * 60 * 60 * 1000;

/** One document is ~45 KB in the worst case; twenty of them stay under a megabyte */
const MAX_ENTRIES = 20;

interface CacheEntry {
    readonly document: CachedSearchDocument;
    readonly storedAt: number;
}

/** Insertion order doubles as LRU order: the oldest entry is evicted first */
const entries = new Map<string, CacheEntry>();

const expired = (entry: CacheEntry, now: number): boolean => now - entry.storedAt >= TTL_MS;

/** Keep one folded footer's document until its page can read the stored version */
export const rememberSearchDocument = (
    token: string,
    document: CachedSearchDocument,
    now: number = Date.now()
): void => {
    entries.delete(token);
    entries.set(token, { document, storedAt: now });
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
};

/** The live document of a token; null when it was never cached or has expired */
export const cachedSearchDocument = (
    token: string,
    now: number = Date.now()
): CachedSearchDocument | null => {
    const entry = entries.get(token);
    if (entry === undefined) return null;
    if (expired(entry, now)) {
        entries.delete(token);
        return null;
    }
    // A read is a use: keep recently opened pages longer than idle ones
    entries.delete(token);
    entries.set(token, entry);
    return entry.document;
};

/** Drop every cached document (offline cases only) */
export const clearSearchDocumentCache = (): void => {
    entries.clear();
};
