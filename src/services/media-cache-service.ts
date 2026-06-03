/**
 * Media cache service.
 * Content-addressed by Telegram file_unique_id so duplicate media (especially
 * re-sent stickers) is downloaded/rendered only once.
 */
import { MediaCache } from '../db/mediaCacheDTO.js';

export interface CachedMedia {
    mime: string;
    data: Buffer;
    kind: string;
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

    return { mime: row.mime, data: row.data, kind: row.kind };
};

/**
 * Store (or replace) a media entry in the cache.
 */
export const putCachedMedia = async (
    fileUniqueId: string,
    data: Buffer,
    mime: string,
    kind: string
): Promise<void> => {
    const now = new Date();
    await MediaCache.upsert({
        fileUniqueId,
        data,
        mime,
        kind,
        lastUsedAt: now,
    });
};
