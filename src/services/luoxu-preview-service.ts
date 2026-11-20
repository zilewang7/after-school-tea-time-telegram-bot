/**
 * Link-preview service backed by luoxu's MTProto client.
 *
 * Bot API never exposes webpage previews, so for messages containing a link we
 * ask luoxu (same host, shared docker network) to read the message live via
 * MTProto and hand back the full preview: text fields, Instant-View article
 * text, and the preview's own media (photo / embedded video / IV page media).
 *
 * Two data sources, in order:
 * 1. the message path (`/preview?g=&id=`), which needs an MTProto channel id
 *    (supergroups and channels only) and depends on the message still existing;
 * 2. the URL path (`/preview-url?url=`, added later), which is message-free and
 *    therefore also works in private chats and after the first message of a
 *    re-posted link was deleted.
 *
 * Previews are cached by URL in LinkPreviewCache together with the outcome:
 * 'ready' (usable and final), 'none' (Telegram says there is no preview) and
 * 'error' (temporary failure). 'none'/'error' carry lastAttemptAt and are
 * retried after their cooldown, so a deleted first message can no longer poison
 * the URL forever.
 *
 * Preview media bytes go into the regular MediaCache (inline <=20MB, GCS above),
 * so storage and cleanup reuse the existing pipeline; both paths share the same
 * media keys.
 *
 * Unconfigured (LUOXU_PREVIEW_URL empty) → everything here is a no-op.
 */
import { createHash } from 'node:crypto';
import { match } from 'ts-pattern';
import { LinkPreviewCache } from '../db/linkPreviewCacheDTO.js';
import { getCachedMedia, putCachedMedia } from './media-cache-service.js';
import { uploadBytesToGcs, isGcsEnabled } from './gcs-service.js';
import { buildOcrFallbackPart } from './luoxu-ocr-service.js';
import { toLuoxuChannelId } from './luoxu-channel-id.js';
import type { UnifiedContentPart } from '../ai/types.js';

export { toLuoxuChannelId };

const luoxuBaseUrl = process.env.LUOXU_PREVIEW_URL;

/** Whether luoxu-backed link previews are configured. */
export const isLuoxuPreviewEnabled = (): boolean => Boolean(luoxuBaseUrl);

/** How long a stored outcome keeps a URL from being fetched again. */
const NONE_RETRY_MS = 10 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;

// Telegram usually settles a pending web page within a few seconds; a stuck
// one must not delay the reply that waits for this acquisition.
const MESSAGE_PENDING_TIMEOUT_MS = 30 * 1000;
const URL_PENDING_TIMEOUT_MS = 15 * 1000;
const URL_PREVIEW_REQUEST_TIMEOUT_MS = 20 * 1000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120 * 1000;

// Poll interval while Telegram is still generating the preview (WebPagePending).
const POLL_INTERVAL_MS = 1000;

// Same boundary as autoSave: above this, bytes go to GCS instead of inline.
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

// Memory-safety cap (preview media is buffered in RAM on both sides; webpage
// documents can theoretically reach 2GB). Mirrors the bigfile MAX_MEDIA_BYTES.
const PREVIEW_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

// gs:// references older than this are deleted by autoClear, so we stop
// offering them to the model. Mirrors context-queries.
const MEDIA_URI_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]]+/;

// t.me / telegram.me links get their own snapshot path; the URL fallback would
// only duplicate Telegram's own "message link" card.
const TELEGRAM_MESSAGE_LINK_PATTERN = /^https?:\/\/(?:t\.me|telegram\.me)\//i;

/** HTTP statuses that mean "this luoxu predates the URL-preview endpoint". */
const MISSING_ENDPOINT_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/** Which data source produced a cached preview, for logs and the panel. */
type LinkPreviewSource = 'message' | 'url';

/** Extract the first http(s) URL from a message text, if any. */
export const extractFirstUrl = (text: string | null | undefined): string | null => {
    if (!text) return null;
    const matched = URL_PATTERN.exec(text);
    return matched ? matched[0] : null;
};

const isTelegramMessageLink = (url: string): boolean => TELEGRAM_MESSAGE_LINK_PATTERN.test(url);

/** Log-safe form of a URL: the host only, share URLs may carry tokens. */
const urlHostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return 'invalid-url';
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

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
    /** Text recognized in the preview / Instant-View images, filled by luoxu-ocr */
    ocrText: string | null;
    /** End of the last acquisition attempt; NULL on rows written before it existed */
    lastAttemptAt: Date | null;
    /** 'message' | 'url' — which source produced this row, diagnostic only */
    source: string | null;
}

/** One cached preview's context parts plus the identity of its content */
export interface LinkPreviewContent {
    readonly parts: UnifiedContentPart[];
    /**
     * Identity of the preview's content: the fields injected plus the media
     * bytes (a gs:// URI for cloud media). The URL and the embed URL are left
     * out on purpose, so the same content reached through two spellings of a
     * link (share/tracking parameters) shares one identity.
     */
    readonly identity: string;
}

/** Why a message's link has no usable preview. */
export type LinkPreviewUnavailableReason = 'none' | 'error' | 'unknown' | 'disabled';

/**
 * A message's link-preview outcome. `none` and `error` are worth telling the
 * model about (Telegram definitely has no preview vs. the fetch failed);
 * `unknown` (no URL, no cache row) and `disabled` are not.
 */
export type LinkPreviewOutcome =
    | { readonly kind: 'ready'; readonly content: LinkPreviewContent }
    | { readonly kind: 'unavailable'; readonly reason: LinkPreviewUnavailableReason };

export interface LinkPreviewQueryOptions {
    /** Add the text recognized in the preview images (models that cannot see them) */
    includeOcrFallback?: boolean;
    /** false: the text parts only, no media bytes are read (the panel's tree view) */
    withMedia?: boolean;
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
    ocrText: row.ocrText,
    lastAttemptAt: row.lastAttemptAt,
    source: row.source,
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

/** How long a stored outcome blocks a new attempt for the same URL. */
const retryDelayOf = (status: string): number | null =>
    match(status)
        .with('none', () => NONE_RETRY_MS)
        .with('error', () => ERROR_RETRY_MS)
        .otherwise(() => null);

/**
 * A stored outcome is not retried before its cooldown ends. A NULL
 * lastAttemptAt marks a row from before this column existed: the attempt is
 * long past, so it may be retried right away.
 */
const isRetryCoolingDown = (cached: CachedLinkPreview): boolean => {
    const retryDelayMs = retryDelayOf(cached.status);
    if (retryDelayMs === null || cached.lastAttemptAt === null) return false;
    return Date.now() - cached.lastAttemptAt.getTime() < retryDelayMs;
};

const isLuoxuPreviewResponse = (value: unknown): value is LuoxuPreviewResponse => {
    if (typeof value !== 'object' || value === null) return false;
    if (!('status' in value)) return false;
    return typeof value.status === 'string';
};

/**
 * The URL-preview endpoint is probed by using it: an old luoxu answers 404/405
 * for it. Remembered for the process lifetime; a restart probes again.
 */
let urlPreviewEndpointMissing = false;

/** Raised when luoxu has no /preview-url endpoint (it predates it). */
class UrlPreviewEndpointMissingError extends Error {
    constructor(status: number) {
        super(`luoxu /preview-url HTTP ${status}`);
        this.name = 'UrlPreviewEndpointMissingError';
    }
}

const fetchMessagePreviewJson = async (
    channelId: number,
    messageId: number
): Promise<LuoxuPreviewResponse> => {
    const endpoint = `${luoxuBaseUrl}/preview?g=${channelId}&id=${messageId}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(URL_PREVIEW_REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`luoxu /preview HTTP ${res.status}`);
    }
    const payload: unknown = await res.json();
    if (!isLuoxuPreviewResponse(payload)) {
        throw new Error('luoxu /preview returned an unexpected payload');
    }
    return payload;
};

const fetchUrlPreviewJson = async (url: string): Promise<LuoxuPreviewResponse> => {
    const endpoint = `${luoxuBaseUrl}/preview-url?url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(URL_PREVIEW_REQUEST_TIMEOUT_MS) });
    if (MISSING_ENDPOINT_STATUSES.has(res.status)) {
        if (!urlPreviewEndpointMissing) {
            urlPreviewEndpointMissing = true;
            console.warn(
                `[luoxu-preview] luoxu has no /preview-url endpoint (HTTP ${res.status}); ` +
                'URL fallback disabled until restart'
            );
        }
        throw new UrlPreviewEndpointMissingError(res.status);
    }
    if (!res.ok) {
        throw new Error(`luoxu /preview-url HTTP ${res.status}`);
    }
    const payload: unknown = await res.json();
    if (!isLuoxuPreviewResponse(payload)) {
        throw new Error('luoxu /preview-url returned an unexpected payload');
    }
    return payload;
};

const fetchPreviewMediaBytes = async (
    channelId: number,
    messageId: number,
    which: string
): Promise<Buffer | null> => {
    const endpoint = `${luoxuBaseUrl}/preview-media?g=${channelId}&id=${messageId}&which=${encodeURIComponent(which)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`luoxu /preview-media HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
};

const fetchUrlPreviewMediaBytes = async (url: string, which: string): Promise<Buffer | null> => {
    const endpoint = `${luoxuBaseUrl}/preview-url-media?url=${encodeURIComponent(url)}&which=${encodeURIComponent(which)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`luoxu /preview-url-media HTTP ${res.status}`);
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
    info: LuoxuMediaInfo,
    fetchBytes: (which: string) => Promise<Buffer | null>
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

    const bytes = await fetchBytes(info.which);
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

/** Store every media item of one preview; a failed item degrades to text only. */
const storePreviewMediaItems = async (
    url: string,
    items: readonly LuoxuMediaInfo[],
    fetchBytes: (which: string) => Promise<Buffer | null>
): Promise<PreviewMediaDescriptor[]> => {
    const descriptors: PreviewMediaDescriptor[] = [];
    for (const info of items) {
        try {
            const descriptor = await storePreviewMedia(url, info, fetchBytes);
            if (descriptor) {
                descriptors.push(descriptor);
            }
        } catch (error) {
            console.error(
                `[luoxu-preview] media ${info.which} store failed:`,
                errorMessageOf(error)
            );
        }
    }
    return descriptors;
};

/** Persist a usable preview; ready is final, so this always overwrites. */
const persistReadyPreview = async (
    url: string,
    preview: LuoxuPreviewResponse,
    source: LinkPreviewSource,
    mediaItems: readonly PreviewMediaDescriptor[]
): Promise<CachedLinkPreview | null> => {
    const now = new Date();
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
        source,
        lastAttemptAt: now,
        lastUsedAt: now,
    });

    console.log(
        `[luoxu-preview] cached ready preview host=${urlHostOf(url)} source=${source} ` +
        `media=${mediaItems.length} iv=${preview.full_text ? 'yes' : 'no'}`
    );

    return getLinkPreviewFromCache(url);
};

/**
 * Persist a non-usable outcome. Re-reads first: a concurrent attempt may have
 * stored a usable preview meanwhile, and a good result is never overwritten.
 */
const persistUnavailablePreview = async (
    url: string,
    status: 'none' | 'error',
    source: LinkPreviewSource
): Promise<void> => {
    const existing = await LinkPreviewCache.findByPk(url);
    if (existing?.status === 'ready') return;

    const now = new Date();
    const values = { status, source, lastAttemptAt: now, lastUsedAt: now };
    if (existing === null) {
        await LinkPreviewCache.create({ url, ...values });
    } else {
        await existing.update(values);
    }

    console.log(
        `[luoxu-preview] cached ${status} outcome host=${urlHostOf(url)} source=${source}`
    );
};

/** What one acquisition path found. */
type PreviewAttempt =
    | { readonly kind: 'ready'; readonly preview: LuoxuPreviewResponse }
    | { readonly kind: 'none' }
    | { readonly kind: 'transient'; readonly detail: string }
    /** Old luoxu: no URL-preview endpoint at all (keep today's behavior) */
    | { readonly kind: 'unavailable' }
    /** This path does not apply to this message/URL (private chat, t.me link) */
    | { readonly kind: 'skipped' };

/**
 * Poll a preview endpoint until Telegram settles it (ready/none) or the pending
 * timeout passes. Never throws: a transport failure is a transient outcome.
 */
const pollPreviewUntilSettled = async (
    fetchOnce: () => Promise<LuoxuPreviewResponse>,
    pendingTimeoutMs: number,
    label: string
): Promise<PreviewAttempt> => {
    const deadline = Date.now() + pendingTimeoutMs;
    try {
        let preview = await fetchOnce();
        while (preview.status === 'pending') {
            if (Date.now() >= deadline) {
                return { kind: 'transient', detail: `${label} still pending after ${pendingTimeoutMs}ms` };
            }
            await sleep(POLL_INTERVAL_MS);
            preview = await fetchOnce();
        }
        if (preview.status === 'ready') return { kind: 'ready', preview };
        return { kind: 'none' };
    } catch (error) {
        if (error instanceof UrlPreviewEndpointMissingError) {
            return { kind: 'unavailable' };
        }
        return { kind: 'transient', detail: errorMessageOf(error) };
    }
};

/** Message path: read the preview off the message itself (needs a channel id). */
const attemptMessagePreview = async (
    chatId: number,
    messageId: number
): Promise<PreviewAttempt> => {
    const channelId = toLuoxuChannelId(chatId);
    if (channelId === null) return { kind: 'skipped' };
    return pollPreviewUntilSettled(
        () => fetchMessagePreviewJson(channelId, messageId),
        MESSAGE_PENDING_TIMEOUT_MS,
        'message preview'
    );
};

/** URL path: message-free fallback, also the only data source in private chats. */
const attemptUrlPreview = async (url: string): Promise<PreviewAttempt> => {
    if (isTelegramMessageLink(url)) return { kind: 'skipped' };
    if (urlPreviewEndpointMissing) return { kind: 'unavailable' };
    return pollPreviewUntilSettled(
        () => fetchUrlPreviewJson(url),
        URL_PENDING_TIMEOUT_MS,
        'url preview'
    );
};

/**
 * Without a usable URL fallback the old behavior is kept: only a confirmed
 * message-path 'none' is cached; transport failures are not remembered.
 */
const finishWithoutUrlPreview = async (
    messageAttempt: PreviewAttempt,
    url: string
): Promise<CachedLinkPreview | null> => {
    if (messageAttempt.kind === 'none') {
        await persistUnavailablePreview(url, 'none', 'message');
    }
    return null;
};

const acquireThroughMessagePath = async (
    url: string,
    chatId: number,
    messageId: number,
    preview: LuoxuPreviewResponse
): Promise<CachedLinkPreview | null> => {
    const channelId = toLuoxuChannelId(chatId);
    const mediaItems = channelId === null
        ? []
        : await storePreviewMediaItems(
            url,
            preview.media ?? [],
            (which) => fetchPreviewMediaBytes(channelId, messageId, which)
        );
    return persistReadyPreview(url, preview, 'message', mediaItems);
};

const acquireThroughUrlPath = async (
    url: string,
    preview: LuoxuPreviewResponse
): Promise<CachedLinkPreview | null> => {
    const mediaItems = await storePreviewMediaItems(
        url,
        preview.media ?? [],
        (which) => fetchUrlPreviewMediaBytes(url, which)
    );
    return persistReadyPreview(url, preview, 'url', mediaItems);
};

/** One acquisition: message path first, then the URL fallback, then persist. */
const doAcquireLinkPreview = async (
    chatId: number,
    messageId: number,
    url: string
): Promise<CachedLinkPreview | null> => {
    const messageAttempt = await attemptMessagePreview(chatId, messageId);
    if (messageAttempt.kind === 'ready') {
        return acquireThroughMessagePath(url, chatId, messageId, messageAttempt.preview);
    }

    const urlAttempt = await attemptUrlPreview(url);
    if (urlAttempt.kind === 'ready') {
        return acquireThroughUrlPath(url, urlAttempt.preview);
    }

    return match(urlAttempt)
        .with({ kind: 'none' }, async () => {
            // Telegram confirmed there is no preview: a final answer (for now).
            await persistUnavailablePreview(url, 'none', 'url');
            return null;
        })
        .with({ kind: 'transient' }, async (attempt) => {
            // A temporary failure must not look like "no preview"; retried later.
            console.log(
                `[luoxu-preview] url fallback failed host=${urlHostOf(url)} (${attempt.detail})`
            );
            await persistUnavailablePreview(url, 'error', 'url');
            return null;
        })
        .with({ kind: 'unavailable' }, () => finishWithoutUrlPreview(messageAttempt, url))
        .with({ kind: 'skipped' }, () => finishWithoutUrlPreview(messageAttempt, url))
        .exhaustive();
};

/** An acquisition another message started for the same URL. */
interface InflightAcquisition {
    readonly promise: Promise<CachedLinkPreview | null>;
    readonly messageId: number;
}

/** In-flight acquisitions by URL, so concurrent triggers share one fetch */
const inflightAcquisitions = new Map<string, InflightAcquisition>();

const startAcquisition = (
    chatId: number,
    messageId: number,
    url: string
): Promise<CachedLinkPreview | null> => {
    const promise = doAcquireLinkPreview(chatId, messageId, url);
    const entry: InflightAcquisition = { promise, messageId };
    inflightAcquisitions.set(url, entry);
    const clear = (): void => {
        if (inflightAcquisitions.get(url) === entry) inflightAcquisitions.delete(url);
    };
    void promise.then(clear, clear);
    return promise;
};

/**
 * Acquire the link preview for a message containing `url` and store it in the
 * URL-addressed cache; returns the cached preview when it is usable.
 *
 * A cached 'none'/'error' outcome is retried only after its cooldown. The first
 * message-path attempt of a URL is shared by every concurrent trigger; a second
 * message that shared a failed attempt gets one attempt of its own, because the
 * message path can fail for reasons of the first message alone (it was deleted
 * while Telegram was still settling its preview).
 */
export const acquireLinkPreview = async (
    chatId: number,
    messageId: number,
    url: string
): Promise<CachedLinkPreview | null> => {
    if (!isLuoxuPreviewEnabled()) return null;

    const cached = await getLinkPreviewFromCache(url);
    if (cached?.status === 'ready') return cached;
    if (cached !== null && isRetryCoolingDown(cached)) return null;

    const inflight = inflightAcquisitions.get(url);
    if (inflight !== undefined) {
        const shared = await inflight.promise.catch(() => null);
        if (shared !== null) return shared;

        const afterWait = await getLinkPreviewFromCache(url);
        if (afterWait?.status === 'ready') return afterWait;
        // The shared attempt settled on a final "no preview": nothing to add.
        if (afterWait?.status === 'none') return null;
        // The same message tries once; a different message gets one own attempt.
        if (inflight.messageId === messageId) return null;
    }

    return startAcquisition(chatId, messageId, url);
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

const mediaIdentityOf = (cached: { fileUri: string | null; data: Buffer | null }): string => {
    if (cached.fileUri) return `uri:${cached.fileUri}`;
    if (cached.data) return `sha256:${createHash('sha256').update(cached.data).digest('hex')}`;
    return 'missing';
};

const previewIdentityOf = (
    preview: CachedLinkPreview,
    mediaIdentities: readonly string[]
): string =>
    createHash('sha256')
        .update(JSON.stringify({
            siteName: preview.siteName,
            title: preview.title,
            author: preview.author,
            description: preview.description,
            fullText: preview.fullText,
            ocrText: preview.ocrText,
            media: mediaIdentities,
        }))
        .digest('hex');

/** Build the context parts (text + media) of one cached preview. */
const buildPreviewContent = async (
    preview: CachedLinkPreview,
    options: LinkPreviewQueryOptions
): Promise<LinkPreviewContent> => {
    const parts: UnifiedContentPart[] = [{ type: 'text', text: buildPreviewText(preview) }];

    if (options.includeOcrFallback && preview.ocrText) {
        parts.push({ type: 'text', text: buildOcrFallbackPart(preview.ocrText) });
    }

    const mediaIdentities: string[] = [];
    if (options.withMedia !== false) {
        for (const item of preview.mediaItems) {
            const cached = await getCachedMedia(item.mediaKey);
            if (!cached) continue; // media expired (autoClear) → text-only degrade

            if (cached.fileUri) {
                const ageMs = Date.now() - new Date(cached.createdAt).getTime();
                if (ageMs > MEDIA_URI_TTL_MS) continue;
                mediaIdentities.push(mediaIdentityOf(cached));
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
            mediaIdentities.push(mediaIdentityOf(cached));
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
    }

    return { parts, identity: previewIdentityOf(preview, mediaIdentities) };
};

/**
 * The link-preview outcome for the first URL found in a message text, read
 * from the cache only (acquisition happens in autoSave).
 *
 * `unavailable` reasons: 'none' (Telegram has no preview — worth telling the
 * model), 'error' (the fetch failed temporarily — worth telling it too),
 * 'unknown' (no URL, no cache row, or a t.me link with its own snapshot path)
 * and 'disabled' (luoxu previews are off). The last two are not worth a note.
 */
export const getLinkPreviewOutcome = async (
    text: string | null | undefined,
    options: LinkPreviewQueryOptions = {}
): Promise<LinkPreviewOutcome> => {
    if (!isLuoxuPreviewEnabled()) return { kind: 'unavailable', reason: 'disabled' };

    const url = extractFirstUrl(text);
    if (url === null) return { kind: 'unavailable', reason: 'unknown' };

    const preview = await getLinkPreviewFromCache(url);
    if (preview === null) return { kind: 'unavailable', reason: 'unknown' };
    if (preview.status === 'ready') {
        return { kind: 'ready', content: await buildPreviewContent(preview, options) };
    }
    // t.me links have their own snapshot block; a status line would only
    // duplicate what that block already says.
    if (isTelegramMessageLink(url)) return { kind: 'unavailable', reason: 'unknown' };
    if (preview.status === 'none') return { kind: 'unavailable', reason: 'none' };
    if (preview.status === 'error') return { kind: 'unavailable', reason: 'error' };
    return { kind: 'unavailable', reason: 'unknown' };
};

/**
 * Build the context parts (text + media) for the first URL found in a message
 * text, reading only from the cache — acquisition happens in autoSave. Returns
 * null when disabled, no URL, cache miss, or a non-ready status.
 *
 * `includeOcrFallback` adds the text recognized in the preview images, for
 * models that would otherwise receive nothing at all about them.
 */
export const getLinkPreviewWithIdentity = async (
    text: string | null | undefined,
    options: LinkPreviewQueryOptions = {}
): Promise<LinkPreviewContent | null> => {
    const outcome = await getLinkPreviewOutcome(text, options);
    return outcome.kind === 'ready' ? outcome.content : null;
};

/**
 * The parts only (see getLinkPreviewWithIdentity). The panel's tree view and
 * the share page show one preview per message and do not need the identity.
 */
export const getLinkPreviewParts = async (
    text: string | null | undefined,
    options: LinkPreviewQueryOptions = {}
): Promise<UnifiedContentPart[]> =>
    (await getLinkPreviewWithIdentity(text, options))?.parts ?? [];
