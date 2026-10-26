/**
 * The runtime side of the fixed sticker pack: turn a catalog entry into the
 * current file_id, and fetch the picture for a preview.
 *
 * The catalog holds `file_unique_id`, not `file_id`: the unique id survives a
 * bot token change and still identifies the same picture after the author
 * edits the pack. A missing unique id means the pack no longer looks like the
 * catalog, and the caller must not fall back to the position (that would send
 * a different picture). Regenerate the catalog instead.
 *
 * Thumbnails are cached by unique id; originals are downloaded on demand.
 */
import { sniffImageMime, type SniffedImageMime } from '../ai/image-generation/image-mime.js';
import { downloadTelegramFile } from './telegram-file-service.js';
import type { StickerCatalogEntry } from './sticker-catalog.js';

/** The shape both the real Api and a test double satisfy */
export interface StickerSetSticker {
    readonly file_id: string;
    readonly file_unique_id: string;
    readonly thumbnail?: { readonly file_id?: string };
}

export interface StickerSetApi {
    getStickerSet(name: string): Promise<{ readonly stickers: readonly StickerSetSticker[] }>;
    getFile(fileId: string): Promise<{ readonly file_path?: string }>;
}

export type StickerSetErrorKind = 'unavailable' | 'changed';

export class StickerSetError extends Error {
    readonly kind: StickerSetErrorKind;

    constructor(kind: StickerSetErrorKind, message: string) {
        super(message);
        this.name = 'StickerSetError';
        this.kind = kind;
    }
}

export type StickerPreviewView = 'thumbnail' | 'original';

export interface StickerPreview {
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
}

interface StickerSetEntry {
    readonly fileId: string;
    readonly thumbnailFileId?: string;
}

interface CachedStickerSet {
    readonly byUniqueId: ReadonlyMap<string, StickerSetEntry>;
    readonly fetchedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, CachedStickerSet>();
const inflight = new Map<string, Promise<CachedStickerSet>>();
const thumbnailCache = new Map<string, Buffer>();

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const buildCache = (set: { readonly stickers: readonly StickerSetSticker[] }): CachedStickerSet => {
    const byUniqueId = new Map<string, StickerSetEntry>();
    for (const sticker of set.stickers) {
        byUniqueId.set(sticker.file_unique_id, {
            fileId: sticker.file_id,
            ...(sticker.thumbnail?.file_id === undefined
                ? {}
                : { thumbnailFileId: sticker.thumbnail.file_id }),
        });
    }
    return { byUniqueId, fetchedAt: Date.now() };
};

const loadStickerSet = async (
    api: StickerSetApi,
    setName: string
): Promise<CachedStickerSet> => {
    const cached = cache.get(setName);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

    const running = inflight.get(setName);
    if (running) return running;

    const promise = (async (): Promise<CachedStickerSet> => {
        try {
            const value = buildCache(await api.getStickerSet(setName));
            cache.set(setName, value);
            return value;
        } catch (error) {
            throw new StickerSetError(
                'unavailable',
                `贴纸包暂时不可用（getStickerSet ${setName} 失败：${messageOf(error)}）`
            );
        } finally {
            inflight.delete(setName);
        }
    })();
    inflight.set(setName, promise);
    return promise;
};

const entryOf = (
    set: CachedStickerSet,
    entry: StickerCatalogEntry
): StickerSetEntry => {
    const found = set.byUniqueId.get(entry.fileUniqueId);
    if (!found) {
        throw new StickerSetError(
            'changed',
            `贴纸包已更新：第 ${entry.packIndex} 张（${entry.label}）不在新包里，目录需要同步`
        );
    }
    return found;
};

export interface ResolvedSticker {
    readonly fileId: string;
    readonly entry: StickerCatalogEntry;
}

export const resolveSticker = async (
    api: StickerSetApi,
    setName: string,
    entry: StickerCatalogEntry
): Promise<ResolvedSticker> => {
    const set = await loadStickerSet(api, setName);
    return { fileId: entryOf(set, entry).fileId, entry };
};

export const downloadStickerPreview = async (
    api: StickerSetApi,
    setName: string,
    entry: StickerCatalogEntry,
    view: StickerPreviewView,
    signal?: AbortSignal
): Promise<StickerPreview> => {
    const set = await loadStickerSet(api, setName);
    const resolved = entryOf(set, entry);
    const cacheKey = `${setName}:${entry.fileUniqueId}:${view}`;

    if (view === 'thumbnail') {
        const cached = thumbnailCache.get(cacheKey);
        if (cached) {
            const mimeType = sniffImageMime(cached);
            if (mimeType) return { data: cached, mimeType };
        }
    }

    const fileId =
        view === 'thumbnail' ? resolved.thumbnailFileId ?? resolved.fileId : resolved.fileId;
    const { bytes } = await downloadTelegramFile({ api }, fileId, signal);
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) {
        throw new StickerSetError('unavailable', '贴纸文件不是可识别的图片格式');
    }
    if (view === 'thumbnail') thumbnailCache.set(cacheKey, bytes);
    return { data: bytes, mimeType };
};

/** Drop the cached file_ids after a `STICKER_INVALID`; the next call re-reads the pack. */
export const invalidateStickerSet = (setName: string): void => {
    cache.delete(setName);
};
