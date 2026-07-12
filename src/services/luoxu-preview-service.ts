/**
 * Link-preview service backed by luoxu's MTProto client.
 *
 * Bot API never exposes webpage previews, so for messages containing a link we
 * ask luoxu (same host, shared docker network) to read the message live via
 * MTProto and hand back the full preview: text fields, Instant-View article
 * text, and the preview's own media (photo / embedded video / IV page media).
 *
 * Previews are cached by URL in LinkPreviewCache (one fetch per unique link);
 * preview media bytes go into the regular MediaCache (inline <=20MB, GCS above),
 * so storage and cleanup reuse the existing pipeline.
 *
 * Unconfigured (LUOXU_PREVIEW_URL empty) → everything here is a no-op.
 */
import { createHash } from 'node:crypto';
import { LinkPreviewCache } from '../db/linkPreviewCacheDTO.js';
import { getCachedMedia, putCachedMedia } from './media-cache-service.js';
import { uploadBytesToGcs, isGcsEnabled } from './gcs-service.js';
import type { UnifiedContentPart } from '../ai/types.js';

const luoxuBaseUrl = process.env.LUOXU_PREVIEW_URL;

/** Whether luoxu-backed link previews are configured. */
export const isLuoxuPreviewEnabled = (): boolean => Boolean(luoxuBaseUrl);

// Poll interval while Telegram is still generating the preview (WebPagePending).
// No upper bound: pending is a transient state and always resolves to a
// terminal ready/none, so waiting until confirmation terminates naturally.
const POLL_INTERVAL_MS = 1000;

// Same boundary as autoSave: above this, bytes go to GCS instead of inline.
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

// Memory-safety cap (preview media is buffered in RAM on both sides; webpage
// documents can theoretically reach 2GB). Mirrors the bigfile MAX_MEDIA_BYTES.
const PREVIEW_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

// gs:// references older than this are likely deleted (autoClear + bucket
// lifecycle), so we stop offering them to the model. Mirrors context-queries.
const MEDIA_URI_TTL_MS = 24 * 60 * 60 * 1000;

const URL_PATTERN = /https?:\/\/[^\s<>"'()\[\]]+/;

/** Extract the first http(s) URL from a message text, if any. */
export const extractFirstUrl = (text: string | null | undefined): string | null => {
    if (!text) return null;
    const matched = URL_PATTERN.exec(text);
    return matched ? matched[0] : null;
};

/**
 * Bot API supergroup/channel ids look like -100<channel_id>; luoxu (MTProto)
 * uses the bare channel_id. Returns null for chats luoxu can't address.
 */
const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const urlHash = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 24);

/** Stable MediaCache key for one preview media item of one URL. */
const buildPreviewMediaKey = (url: string, which: string): string =>
    `luoxu-preview:${urlHash(url)}:${which}`;

interface LuoxuMediaInfo {
    which: string;
    kind: string;
    mime: string;
    size: number;
}

interface LuoxuPreviewResponse {
    status: string; // 'ready' | 'pending' | 'none'
    url?: string | null;
    display_url?: string | null;
    site_name?: string | null;
    title?: string | null;
    description?: string | null;
    type?: string | null;
    author?: string | null;
    embed_url?: string | null;
    full_text?: string | null;
    media?: LuoxuMediaInfo[];
}

/** One stored preview media descriptor (serialized into LinkPreviewCache.mediaItems). */
interface PreviewMediaDescriptor {
    which: string;
    kind: string;
    mime: string;
    mediaKey: string;
    sizeBytes: number;
}

export interface CachedLinkPreview {
    url: string;
    status: string;
    siteName: string | null;
    title: string | null;
    description: string | null;
    previewType: string | null;
    author: string | null;
    embedUrl: string | null;
    fullText: string | null;
    mediaItems: PreviewMediaDescriptor[];
}

const parseMediaItems = (serialized: string | null): PreviewMediaDescriptor[] => {
    if (!serialized) return [];
    try {
        const parsed: unknown = JSON.parse(serialized);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const rowToPreview = (row: LinkPreviewCache): CachedLinkPreview => ({
    url: row.url,
    status: row.status,
    siteName: row.siteName,
    title: row.title,
    description: row.description,
    previewType: row.previewType,
    author: row.author,
    embedUrl: row.embedUrl,
    fullText: row.fullText,
    mediaItems: parseMediaItems(row.mediaItems),
});

/** Cache lookup by URL; refreshes lastUsedAt on hit (fire-and-forget). */
export const getLinkPreviewFromCache = async (url: string): Promise<CachedLinkPreview | null> => {
    const row = await LinkPreviewCache.findByPk(url);
    if (!row) return null;
    row.lastUsedAt = new Date();
    row.save().catch((error) => {
        console.error('[luoxu-preview] Failed to refresh lastUsedAt:', error);
    });
    return rowToPreview(row);
};

const isLuoxuPreviewResponse = (value: unknown): value is LuoxuPreviewResponse => {
    if (typeof value !== 'object' || value === null) return false;
    if (!('status' in value)) return false;
    return typeof value.status === 'string';
};

const fetchPreviewJson = async (channelId: number, messageId: number): Promise<LuoxuPreviewResponse> => {
    const endpoint = `${luoxuBaseUrl}/preview?g=${channelId}&id=${messageId}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`luoxu /preview HTTP ${res.status}`);
    }
    const payload: unknown = await res.json();
    if (!isLuoxuPreviewResponse(payload)) {
        throw new Error('luoxu /preview returned an unexpected payload');
    }
    return payload;
};

const fetchPreviewMediaBytes = async (
    channelId: number,
    messageId: number,
    which: string
): Promise<Buffer | null> => {
    const endpoint = `${luoxuBaseUrl}/preview-media?g=${channelId}&id=${messageId}&which=${encodeURIComponent(which)}`;
    const res = await fetch(endpoint);
    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`luoxu /preview-media HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
};

/**
 * Store one preview media item into MediaCache (inline or GCS), returning its
 * descriptor, or null when the item can't be stored (download failed / too
 * large without GCS). Re-uses an existing cache row when present.
 */
const storePreviewMedia = async (
    url: string,
    channelId: number,
    messageId: number,
    info: LuoxuMediaInfo
): Promise<PreviewMediaDescriptor | null> => {
    if (info.size > PREVIEW_MEDIA_MAX_BYTES) {
        console.log(`[luoxu-preview] skip media ${info.which} (${info.size} bytes > cap)`);
        return null;
    }

    const mediaKey = buildPreviewMediaKey(url, info.which);

    const existing = await getCachedMedia(mediaKey);
    if (existing) {
        return {
            which: info.which,
            kind: existing.kind,
            mime: existing.mime,
            mediaKey,
            sizeBytes: existing.sizeBytes ?? info.size,
        };
    }

    const bytes = await fetchPreviewMediaBytes(channelId, messageId, info.which);
    if (!bytes || !bytes.length) return null;

    if (bytes.length > INLINE_MAX_BYTES) {
        if (!isGcsEnabled()) return null;
        const fileUri = await uploadBytesToGcs(bytes, mediaKey, info.mime);
        await putCachedMedia({
            fileUniqueId: mediaKey,
            fileUri,
            sizeBytes: bytes.length,
            mime: info.mime,
            kind: info.kind,
        });
    } else {
        await putCachedMedia({
            fileUniqueId: mediaKey,
            data: bytes,
            sizeBytes: bytes.length,
            mime: info.mime,
            kind: info.kind,
        });
    }

    return {
        which: info.which,
        kind: info.kind,
        mime: info.mime,
        mediaKey,
        sizeBytes: bytes.length,
    };
};

/**
 * Acquire the link preview for a message containing `url` and store it in the
 * URL-addressed cache. Waits (1s polls, unbounded) while Telegram is still
 * generating the preview; returns null on hard failures (luoxu unreachable,
 * chat not addressable) without throwing.
 */
/** In-flight acquisitions by URL, so concurrent triggers share one fetch */
const inflightAcquisitions = new Map<string, Promise<CachedLinkPreview | null>>();

export const acquireLinkPreview = (
    chatId: number,
    messageId: number,
    url: string
): Promise<CachedLinkPreview | null> => {
    const inflight = inflightAcquisitions.get(url);
    if (inflight) return inflight;

    const acquisition = doAcquireLinkPreview(chatId, messageId, url);
    inflightAcquisitions.set(url, acquisition);
    void acquisition.then(
        () => inflightAcquisitions.delete(url),
        () => inflightAcquisitions.delete(url)
    );
    return acquisition;
};

const doAcquireLinkPreview = async (
    chatId: number,
    messageId: number,
    url: string
): Promise<CachedLinkPreview | null> => {
    if (!isLuoxuPreviewEnabled()) return null;

    const cached = await getLinkPreviewFromCache(url);
    if (cached) return cached;

    const channelId = toLuoxuChannelId(chatId);
    if (channelId === null) return null;

    let preview: LuoxuPreviewResponse;
    try {
        preview = await fetchPreviewJson(channelId, messageId);
        while (preview.status === 'pending') {
            await sleep(POLL_INTERVAL_MS);
            preview = await fetchPreviewJson(channelId, messageId);
        }
    } catch (error) {
        console.error('[luoxu-preview] preview fetch failed:', error instanceof Error ? error.message : error);
        return null;
    }

    if (preview.status !== 'ready') {
        // Terminal "no preview": cache it so the same URL doesn't re-trigger fetches.
        await LinkPreviewCache.upsert({ url, status: 'none', lastUsedAt: new Date() });
        return null;
    }

    const mediaItems: PreviewMediaDescriptor[] = [];
    for (const info of preview.media ?? []) {
        try {
            const descriptor = await storePreviewMedia(url, channelId, messageId, info);
            if (descriptor) {
                mediaItems.push(descriptor);
            }
        } catch (error) {
            console.error(`[luoxu-preview] media ${info.which} store failed:`, error instanceof Error ? error.message : error);
        }
    }

    await LinkPreviewCache.upsert({
        url,
        status: 'ready',
        siteName: preview.site_name ?? null,
        title: preview.title ?? null,
        description: preview.description ?? null,
        previewType: preview.type ?? null,
        author: preview.author ?? null,
        embedUrl: preview.embed_url ?? null,
        fullText: preview.full_text ?? null,
        mediaItems: mediaItems.length ? JSON.stringify(mediaItems) : null,
        lastUsedAt: new Date(),
    });

    console.log(
        `[luoxu-preview] cached preview for ${url} ` +
        `(title: ${preview.title ?? 'n/a'}, media: ${mediaItems.length}, iv: ${preview.full_text ? 'yes' : 'no'})`
    );

    return getLinkPreviewFromCache(url);
};

/** Render the preview's text fields into one context part. */
const buildPreviewText = (preview: CachedLinkPreview): string => {
    const lines: string[] = ['[system] 链接预览：'];
    if (preview.siteName) lines.push(`站点: ${preview.siteName}`);
    if (preview.title) lines.push(`标题: ${preview.title}`);
    if (preview.author) lines.push(`作者: ${preview.author}`);
    if (preview.description) lines.push(`描述: ${preview.description}`);
    lines.push(`URL: ${preview.url}`);
    if (preview.embedUrl) lines.push(`嵌入页: ${preview.embedUrl}`);
    if (preview.fullText) lines.push(`全文:\n${preview.fullText}`);
    return lines.join('\n');
};

/**
 * Build the context parts (text + media) for the first URL found in a message
 * text, reading only from the cache — acquisition happens in autoSave. Returns
 * [] when disabled, no URL, cache miss, or status 'none'.
 */
export const getLinkPreviewParts = async (text: string | null | undefined): Promise<UnifiedContentPart[]> => {
    if (!isLuoxuPreviewEnabled()) return [];
    const url = extractFirstUrl(text);
    if (!url) return [];

    const preview = await getLinkPreviewFromCache(url);
    if (!preview || preview.status !== 'ready') return [];

    const parts: UnifiedContentPart[] = [{ type: 'text', text: buildPreviewText(preview) }];

    for (const item of preview.mediaItems) {
        const cached = await getCachedMedia(item.mediaKey);
        if (!cached) continue; // media expired (autoClear) → text-only degrade

        if (cached.fileUri) {
            const ageMs = Date.now() - new Date(cached.createdAt).getTime();
            if (ageMs > MEDIA_URI_TTL_MS) continue;
            parts.push({
                type: 'media',
                fileUri: cached.fileUri,
                sizeBytes: cached.sizeBytes ?? undefined,
                mimeType: cached.mime,
                mediaKind: cached.kind,
            });
            continue;
        }

        if (!cached.data) continue;
        const base64 = cached.data.toString('base64');
        if (cached.mime.startsWith('image/')) {
            parts.push({
                type: 'image',
                imageData: base64,
                sizeBytes: cached.sizeBytes ?? cached.data.length,
                mimeType: cached.mime,
            });
        } else {
            parts.push({
                type: 'media',
                mediaData: base64,
                sizeBytes: cached.sizeBytes ?? cached.data.length,
                mimeType: cached.mime,
                mediaKind: cached.kind,
            });
        }
    }

    return parts;
};
