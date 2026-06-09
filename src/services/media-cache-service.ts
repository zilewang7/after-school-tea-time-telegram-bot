/**
 * Media cache service.
 * Content-addressed by Telegram file_unique_id so duplicate media (especially
 * re-sent stickers) is downloaded/rendered only once.
 *
 * Two storage backends, chosen by size at write time:
 * - small media: inline bytes in `data` (SQLite BLOB)
 * - large media (> INLINE_MAX_BYTES): bytes live in GCS, only `fileUri` is kept
 */
import { MediaCache } from '../db/mediaCacheDTO.js';

export interface CachedMedia {
    mime: string;
    data: Buffer | null;
    fileUri: string | null;
    sizeBytes: number | null;
    kind: string;
    createdAt: Date;
}

/**
 * Look up a cached media entry and refresh its lastUsedAt on hit.
 * Returns null on miss.
 */
export const getCachedMedia = async (fileUniqueId: string): Promise<CachedMedia | null> => {
    const row = await MediaCache.findByPk(fileUniqueId);
    if (!row) return null;

    // Refresh recency for LRU cleanup (fire-and-forget, don't block the hit)
    row.lastUsedAt = new Date();
    row.save().catch((error) => {
        console.error('[media-cache] Failed to refresh lastUsedAt:', error);
    });

    return {
        mime: row.mime,
        data: row.data,
        fileUri: row.fileUri,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        createdAt: row.createdAt,
    };
};

/** What to store: either inline `data` (small) or a `fileUri` (large, in GCS). */
export interface PutMediaInput {
    fileUniqueId: string;
    mime: string;
    kind: string;
    data?: Buffer | null;
    fileUri?: string | null;
    sizeBytes?: number | null;
}

/**
 * Store (or replace) a media entry in the cache.
 */
export const putCachedMedia = async (input: PutMediaInput): Promise<void> => {
    const now = new Date();
    await MediaCache.upsert({
        fileUniqueId: input.fileUniqueId,
        data: input.data ?? null,
        fileUri: input.fileUri ?? null,
        sizeBytes: input.sizeBytes ?? null,
        mime: input.mime,
        kind: input.kind,
        lastUsedAt: now,
    });
};
