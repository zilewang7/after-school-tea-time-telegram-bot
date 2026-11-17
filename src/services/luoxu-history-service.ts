/**
 * Read side of luoxu's message archive.
 *
 * luoxu indexes every message of a few groups into PostgreSQL + PGroonga, so
 * "what was said last month" is a query rather than a feature this bot has to
 * store: this service is the thin client for `/search`, `/messages` and
 * `/names`. The per-reply history state maps ids to hits, because ids are only
 * meaningful while one reply is being generated; repeated reads inside a short
 * window are served by `luoxu-response-cache`.
 *
 * `/message-image` bytes are kept inline in MediaCache (7-day LRU) so the same
 * archived picture is downloaded once; larger originals are not cached.
 *
 * Failures are typed instead of thrown as strings: each tool turns one kind
 * into one sentence for the model, and the model decides what to do next.
 *
 * luoxu is reached through the same base URL as the preview service
 * (`LUOXU_PREVIEW_URL`); chat ids are translated by `toLuoxuChannelId`.
 */

import { createHash } from 'node:crypto';
import { withBusyRetry } from '../db/busy-retry.js';
import { getCachedMedia, putCachedMedia } from './media-cache-service.js';
import { cachedLuoxuJson, clearLuoxuResponseCache, isLuoxuCacheEnabled } from './luoxu-response-cache.js';

/** Why a history request could not be answered */
export type HistoryFailureKind =
    /** luoxu's query parser rejected the query (`()`, stray operators) */
    | 'bad-query'
    /** luoxu does not index this chat */
    | 'not-indexed'
    /** the message is gone from Telegram (deleted, or luoxu lost access) */
    | 'missing'
    /** timeout, connection error, 5xx, unexpected payload */
    | 'unavailable';

export class HistoryRequestError extends Error {
    readonly kind: HistoryFailureKind;
    /** Human-readable cause, already safe to show the model */
    readonly detail: string;

    constructor(kind: HistoryFailureKind, detail: string) {
        super(detail);
        this.name = 'HistoryRequestError';
        this.kind = kind;
        this.detail = detail;
    }
}

/** One row of the full-text index */
export interface HistoryHit {
    readonly channelId: number;
    readonly messageId: number;
    /** Unix seconds, from luoxu's `t` */
    readonly timestamp: number;
    readonly fromId: number | null;
    readonly fromName: string;
    /** The whole indexed text, HTML-escaped; keyword spans only with a query */
    readonly html: string;
    readonly editedAt: number | null;
    /** Unix seconds luoxu recorded the deletion; null while the message still exists */
    readonly deletedAt: number | null;
}

export interface HistorySearchOptions {
    /** null = every indexed group (owner-only cross-group scope) */
    readonly channelId: number | null;
    readonly query?: string | null;
    /** Exact ids to read; requires channelId */
    readonly ids?: readonly number[] | null;
    readonly senderId?: number | null;
    readonly start?: number | null;
    readonly end?: number | null;
    /** How many hits to ask for; luoxu defaults to 50 and caps at 200 */
    readonly limit?: number | null;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface HistorySearchOutcome {
    /** channelId → group title, for rendering cross-group hits */
    readonly groups: ReadonlyMap<number, string>;
    readonly hasMore: boolean;
    readonly hits: readonly HistoryHit[];
}

export interface HistorySender {
    readonly uid: number;
    readonly name: string;
}

/** One entity in Bot API shape, as luoxu reports it */
export interface HistoryRawEntity {
    readonly type: string;
    readonly offset: number;
    readonly length: number;
    readonly url?: string;
}

/** What kind of medium a message carries, as luoxu reports it */
export interface HistoryMedia {
    /** sticker / photo / video / animation / audio / document */
    readonly type: string;
    readonly mime: string | null;
    readonly size: number | null;
    readonly duration: number | null;
    /** A sticker's pack emoji (`alt`), the hint a client paints on the bubble */
    readonly stickerEmoji: string | null;
    readonly fileName: string | null;
    readonly voice: boolean;
}

export interface HistoryForward {
    readonly kind: string | null;
    readonly fromId: number | null;
    readonly fromName: string | null;
}

/** A message as Telegram has it right now (no index extras, no OCR) */
export interface HistoryRawMessage {
    readonly messageId: number;
    readonly senderId: number | null;
    readonly senderName: string;
    readonly senderIsBot: boolean;
    readonly text: string;
    readonly entities: readonly HistoryRawEntity[];
    readonly replyToId: number | null;
    readonly media: HistoryMedia | null;
    readonly forward: HistoryForward | null;
    /** Pictures/videos luoxu can serve for this message; null when it did not say */
    readonly imageCount: number | null;
    /** Unix seconds */
    readonly date: number | null;
}

export interface HistoryService {
    readonly search: (options: HistorySearchOptions) => Promise<HistorySearchOutcome>;
    /** Name → candidates; luoxu keeps one row per uid, so duplicates are normal */
    readonly findSenders: (
        channelId: number,
        name: string,
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<readonly HistorySender[]>;
    /** Raw messages by id; deleted ids are simply absent */
    readonly messages: (
        channelId: number,
        ids: readonly number[],
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<readonly HistoryRawMessage[]>;
    /** Archive coverage (message count + time range); cached for a few minutes */
    readonly stats: (
        channelId: number | null,
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<HistoryStats>;
    /** Every image/video one archived message can yield */
    readonly images: (
        channelId: number,
        messageId: number,
        options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<HistoryImageManifest>;
    /** Bytes of one manifest entry; null when luoxu no longer has it */
    readonly imageBytes: (
        channelId: number,
        messageId: number,
        which: string,
        options?: { readonly thumb?: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal }
    ) => Promise<HistoryImageBytes | null>;
}

/** One group's archive coverage */
export interface HistoryGroupStats {
    readonly channelId: number;
    readonly name: string;
    /** Messages luoxu indexed for this group */
    readonly messages: number;
    /** Unix seconds of the oldest indexed message; null for an empty group */
    readonly firstTimestamp: number | null;
    readonly lastTimestamp: number | null;
}

export interface HistoryStats {
    readonly groups: readonly HistoryGroupStats[];
}

/** One image/video an archived message carries, as luoxu describes it */
export interface HistoryImageItem {
    /** Opaque locator `imageBytes` re-resolves (`media`, `photo`, `page_photo_0` …) */
    readonly which: string;
    /** Where it sits: the message itself, its rich block tree, its web preview, its Instant View page */
    readonly source: 'media' | 'rich' | 'preview' | 'page';
    /** photo / sticker / animation / video / document */
    readonly kind: string;
    readonly mime: string;
    readonly size: number | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly duration: number | null;
    readonly fileName: string | null;
}

export interface HistoryImageManifest {
    readonly images: readonly HistoryImageItem[];
    /** The message's own medium, even when it is not an image (video/file/voice) */
    readonly media: HistoryMedia | null;
}

export interface HistoryImageBytes {
    readonly data: Buffer;
    readonly mime: string;
}

export const HISTORY_SEARCH_TIMEOUT_MS = 10_000;
export const HISTORY_MESSAGES_TIMEOUT_MS = 5_000;
export const HISTORY_NAMES_TIMEOUT_MS = 3_000;
export const HISTORY_STATS_TIMEOUT_MS = 5_000;
export const HISTORY_IMAGES_TIMEOUT_MS = 5_000;
export const HISTORY_IMAGE_BYTES_TIMEOUT_MS = 30_000;

/** Most hits one search may ask for (luoxu's ceiling; luoxu itself defaults to 50) */
export const HISTORY_MAX_SEARCH_LIMIT = 200;

/** luoxu caps an id list at 50 per request (`/search?ids=` and `/messages`) */
const MAX_IDS_PER_REQUEST = 50;

/** One image handed to a model is bounded well below luoxu's own 200MB cap */
export const HISTORY_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The JSON response caches: repeated reads of the same page inside one reply (a
 * retried tool call, a page read again while the model thinks) reuse a response
 * for a moment. `/search` tolerates 30s of indexing lag; `/messages` 60s matches
 * the deletion-marking window; names and message media barely change.
 */
const SEARCH_CACHE_TTL_MS = 30 * 1000;
const SEARCH_CACHE_MAX = 8;
const MESSAGES_CACHE_TTL_MS = 60 * 1000;
const MESSAGES_CACHE_MAX = 64;
const NAMES_CACHE_TTL_MS = 10 * 60 * 1000;
const NAMES_CACHE_MAX = 64;
const IMAGES_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGES_CACHE_MAX = 64;

/** Coverage changes slowly and its aggregate costs luoxu ~0.26s per group */
const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_CACHE_MAX = 32;

/**
 * An archived image is kept inline only up to the size the history tools would
 * hand a model anyway (`MAX_ORIGINAL_IMAGE_BYTES` in reply/tools; services may
 * not import that layer). Larger originals stay download-only: caching them
 * would just bloat the SQLite file.
 */
const HISTORY_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** MediaCache key of one archived image; the thumbnail is a row of its own */
const historyImageCacheKey = (channelId: number, messageId: number, which: string, thumb: boolean): string =>
    `luoxu-history-image:${createHash('sha256')
        .update(`${channelId}:${messageId}:${which}:${thumb ? 1 : 0}`)
        .digest('hex')}`;

/** One download per image, shared by every concurrent caller (tools, replies) */
const inflightHistoryImages = new Map<string, Promise<HistoryImageBytes | null>>();

const requestSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const numberOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const failureFor = (
    response: Response,
    detail: string,
    notFoundKind: HistoryFailureKind = 'not-indexed'
): HistoryRequestError => {
    if (response.status === 400) return new HistoryRequestError('bad-query', detail);
    if (response.status === 404) return new HistoryRequestError(notFoundKind, detail);
    return new HistoryRequestError('unavailable', `${detail}（HTTP ${response.status}）`);
};

const parseHit = (raw: unknown, fallbackChannelId: number | null): HistoryHit | null => {
    if (!isRecord(raw)) return null;
    const messageId = numberOf(raw.id);
    const timestamp = numberOf(raw.t);
    const html = stringOf(raw.html);
    if (messageId === null || timestamp === null || html === null) return null;
    return {
        channelId: numberOf(raw.group_id) ?? fallbackChannelId ?? 0,
        messageId,
        timestamp,
        fromId: numberOf(raw.from_id),
        fromName: stringOf(raw.from_name) ?? '',
        html,
        editedAt: numberOf(raw.edited),
        deletedAt: numberOf(raw.deleted),
    };
};

const parseGroups = (raw: unknown): Map<number, string> => {
    const groups = new Map<number, string>();
    if (!isRecord(raw)) return groups;
    for (const [key, value] of Object.entries(raw)) {
        const channelId = Number.parseInt(key, 10);
        if (!Number.isFinite(channelId)) continue;
        if (!Array.isArray(value)) continue;
        const title = stringOf(value[1]);
        groups.set(channelId, title ?? String(channelId));
    }
    return groups;
};

const parseMedia = (raw: unknown): HistoryMedia | null => {
    if (!isRecord(raw)) return null;
    const type = stringOf(raw.type);
    if (type === null) return null;
    return {
        type,
        mime: stringOf(raw.mime),
        size: numberOf(raw.size),
        duration: numberOf(raw.duration),
        stickerEmoji: stringOf(raw.sticker_emoji),
        fileName: stringOf(raw.file_name),
        voice: raw.voice === true,
    };
};

const parseForward = (raw: unknown): HistoryForward | null => {
    if (!isRecord(raw)) return null;
    return {
        kind: stringOf(raw.kind),
        fromId: numberOf(raw.from_id),
        fromName: stringOf(raw.from_name),
    };
};

const parseGroupStats = (raw: unknown): HistoryGroupStats | null => {
    if (!isRecord(raw)) return null;
    const channelId = numberOf(raw.group_id);
    const messages = numberOf(raw.messages);
    if (channelId === null || messages === null) return null;
    return {
        channelId,
        name: stringOf(raw.name) ?? String(channelId),
        messages,
        firstTimestamp: numberOf(raw.first_t),
        lastTimestamp: numberOf(raw.last_t),
    };
};

const isImageSource = (value: string | null): value is 'media' | 'rich' | 'preview' | 'page' =>
    value === 'media' || value === 'rich' || value === 'preview' || value === 'page';

const parseImageItem = (raw: unknown): HistoryImageItem | null => {
    if (!isRecord(raw)) return null;
    const which = stringOf(raw.which);
    const mime = stringOf(raw.mime);
    if (which === null || mime === null) return null;
    const source = stringOf(raw.source);
    return {
        which,
        source: isImageSource(source) ? source : 'media',
        kind: stringOf(raw.kind) ?? 'document',
        mime,
        size: numberOf(raw.size),
        width: numberOf(raw.width),
        height: numberOf(raw.height),
        duration: numberOf(raw.duration),
        fileName: stringOf(raw.file_name),
    };
};

const parseRawMessage = (raw: unknown): HistoryRawMessage | null => {
    if (!isRecord(raw)) return null;
    const messageId = numberOf(raw.id);
    if (messageId === null) return null;
    const entities: HistoryRawEntity[] = [];
    if (Array.isArray(raw.entities)) {
        for (const entity of raw.entities) {
            if (!isRecord(entity)) continue;
            const type = stringOf(entity.type);
            const offset = numberOf(entity.offset);
            const length = numberOf(entity.length);
            if (type === null || offset === null || length === null) continue;
            const url = stringOf(entity.url);
            entities.push(url === null ? { type, offset, length } : { type, offset, length, url });
        }
    }
    const replyTo = isRecord(raw.reply_to) ? numberOf(raw.reply_to.reply_to_msg_id) : null;
    return {
        messageId,
        senderId: numberOf(raw.sender_id),
        senderName: stringOf(raw.sender_name) ?? '',
        senderIsBot: raw.sender_is_bot === true,
        text: stringOf(raw.text) ?? '',
        entities,
        replyToId: numberOf(raw.reply_to) ?? replyTo,
        media: parseMedia(raw.media),
        forward: parseForward(raw.forward),
        imageCount: numberOf(raw.images),
        date: numberOf(raw.date),
    };
};

export interface HistoryServiceOptions {
    /** luoxu base URL, e.g. http://luoxu-api:9008/luoxu; empty disables every call */
    readonly baseUrl: string;
    /** Test hook */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Archive coverage is cached in the shared response cache: one search per reply
 * would otherwise pay luoxu's ~0.26s aggregate every time, and two concurrent
 * replies share one request.
 */
/** Test hook: forget every cached coverage snapshot */
export const clearHistoryStatsCache = (): void => {
    clearLuoxuResponseCache('stats');
};

const buildSearchUrl = (baseUrl: string, options: HistorySearchOptions): string => {
    const params = new URLSearchParams();
    if (options.channelId !== null) params.set('g', String(options.channelId));
    if (options.ids && options.ids.length > 0) {
        params.set('ids', options.ids.slice(0, MAX_IDS_PER_REQUEST).join(','));
    }
    const query = options.query?.trim();
    if (query) params.set('q', query);
    if (options.senderId) params.set('sender', String(options.senderId));
    if (options.start !== null && options.start !== undefined) params.set('start', String(options.start));
    if (options.end !== null && options.end !== undefined) params.set('end', String(options.end));
    if (options.limit !== null && options.limit !== undefined) params.set('limit', String(options.limit));
    return `${baseUrl}/search?${params.toString()}`;
};

export const createHistoryService = (options: HistoryServiceOptions): HistoryService => {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const doFetch = options.fetchImpl ?? fetch;

    const call = async (
        url: string,
        timeoutMs: number,
        signal: AbortSignal | undefined,
        what: string,
        notFoundKind: HistoryFailureKind = 'not-indexed'
    ): Promise<unknown> => {
        if (!baseUrl) throw new HistoryRequestError('unavailable', `${what}未配置（LUOXU_PREVIEW_URL 为空）`);
        let response: Response;
        try {
            response = await doFetch(url, { signal: requestSignal(timeoutMs, signal) });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new HistoryRequestError('unavailable', `${what}请求失败：${detail}`);
        }
        if (!response.ok) throw failureFor(response, `${what}被拒绝`, notFoundKind);
        try {
            return (await response.json()) as unknown;
        } catch {
            throw new HistoryRequestError('unavailable', `${what}返回了无法解析的内容`);
        }
    };

    /** One image download; a 404 is an ordinary "luoxu no longer has it" */
    const callBytes = async (
        url: string,
        timeoutMs: number,
        signal: AbortSignal | undefined,
        what: string
    ): Promise<HistoryImageBytes | null> => {
        if (!baseUrl) throw new HistoryRequestError('unavailable', `${what}未配置（LUOXU_PREVIEW_URL 为空）`);
        let response: Response;
        try {
            response = await doFetch(url, { signal: requestSignal(timeoutMs, signal) });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new HistoryRequestError('unavailable', `${what}请求失败：${detail}`);
        }
        if (response.status === 404) return null;
        if (response.status === 413) {
            throw new HistoryRequestError('unavailable', `${what}太大（超过 luoxu 的 200MB 上限）`);
        }
        if (!response.ok) throw failureFor(response, `${what}被拒绝`);

        const megabytes = (bytes: number): number => Math.round(bytes / 1024 / 1024);
        const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(declared) && declared > HISTORY_IMAGE_MAX_BYTES) {
            throw new HistoryRequestError('unavailable', `${what}太大（${megabytes(declared)}MB）`);
        }

        let data: Buffer;
        try {
            data = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new HistoryRequestError('unavailable', `${what}下载失败：${detail}`);
        }
        if (data.length > HISTORY_IMAGE_MAX_BYTES) {
            throw new HistoryRequestError('unavailable', `${what}太大（${megabytes(data.length)}MB）`);
        }

        const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
        return { data, mime: mime ? mime : 'application/octet-stream' };
    };

    const search = async (searchOptions: HistorySearchOptions): Promise<HistorySearchOutcome> => {
        if (searchOptions.ids && searchOptions.ids.length > 0 && searchOptions.channelId === null) {
            throw new HistoryRequestError('bad-query', '按消息 id 读取必须指定聊天');
        }
        const url = buildSearchUrl(baseUrl, searchOptions);
        return cachedLuoxuJson('search', url, SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX, async () => {
            const payload = await call(
                url,
                searchOptions.timeoutMs ?? HISTORY_SEARCH_TIMEOUT_MS,
                searchOptions.signal,
                '检索'
            );
            if (!isRecord(payload) || !Array.isArray(payload.messages)) {
                throw new HistoryRequestError('unavailable', '检索返回了意料之外的格式');
            }
            const groups = parseGroups(payload.groupinfo);
            const hits: HistoryHit[] = [];
            for (const raw of payload.messages) {
                const hit = parseHit(raw, searchOptions.channelId);
                if (hit) hits.push(hit);
            }
            return { groups, hasMore: payload.has_more === true, hits };
        });
    };

    const findSenders = async (
        channelId: number,
        name: string,
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<readonly HistorySender[]> => {
        const params = new URLSearchParams({ g: String(channelId), q: name });
        const url = `${baseUrl}/names?${params.toString()}`;
        return cachedLuoxuJson('names', url, NAMES_CACHE_TTL_MS, NAMES_CACHE_MAX, async () => {
            const payload = await call(
                url,
                callOptions.timeoutMs ?? HISTORY_NAMES_TIMEOUT_MS,
                callOptions.signal,
                '发言人解析'
            );
            if (!isRecord(payload) || !Array.isArray(payload.names)) return [];
            const senders: HistorySender[] = [];
            for (const item of payload.names) {
                if (!Array.isArray(item)) continue;
                const uid = numberOf(item[0]);
                const senderName = stringOf(item[1]);
                if (uid === null || senderName === null) continue;
                senders.push({ uid, name: senderName });
            }
            return senders;
        });
    };

    const messages = async (
        channelId: number,
        ids: readonly number[],
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<readonly HistoryRawMessage[]> => {
        if (ids.length === 0) return [];
        const params = new URLSearchParams({
            g: String(channelId),
            ids: ids.slice(0, MAX_IDS_PER_REQUEST).join(','),
        });
        const url = `${baseUrl}/messages?${params.toString()}`;
        return cachedLuoxuJson('messages', url, MESSAGES_CACHE_TTL_MS, MESSAGES_CACHE_MAX, async () => {
            const payload = await call(
                url,
                callOptions.timeoutMs ?? HISTORY_MESSAGES_TIMEOUT_MS,
                callOptions.signal,
                '读取原文'
            );
            if (!isRecord(payload) || !Array.isArray(payload.messages)) {
                throw new HistoryRequestError('unavailable', '读取原文返回了意料之外的格式');
            }
            const out: HistoryRawMessage[] = [];
            for (const raw of payload.messages) {
                const message = parseRawMessage(raw);
                if (message) out.push(message);
            }
            return out;
        });
    };

    const stats = async (
        channelId: number | null,
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<HistoryStats> => {
        const params = new URLSearchParams();
        if (channelId !== null) params.set('g', String(channelId));
        const suffix = params.toString();
        const url = `${baseUrl}/stats${suffix ? `?${suffix}` : ''}`;
        return cachedLuoxuJson('stats', url, STATS_TTL_MS, STATS_CACHE_MAX, async () => {
            const payload = await call(
                url,
                callOptions.timeoutMs ?? HISTORY_STATS_TIMEOUT_MS,
                callOptions.signal,
                '归档统计'
            );
            if (!isRecord(payload) || !Array.isArray(payload.groups)) {
                throw new HistoryRequestError('unavailable', '归档统计返回了意料之外的格式');
            }
            const groups: HistoryGroupStats[] = [];
            for (const raw of payload.groups) {
                const group = parseGroupStats(raw);
                if (group) groups.push(group);
            }
            return { groups };
        });
    };

    const images = async (
        channelId: number,
        messageId: number,
        callOptions: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<HistoryImageManifest> => {
        const params = new URLSearchParams({ g: String(channelId), id: String(messageId) });
        const url = `${baseUrl}/message-images?${params.toString()}`;
        return cachedLuoxuJson('images', url, IMAGES_CACHE_TTL_MS, IMAGES_CACHE_MAX, async () => {
            const payload = await call(
                url,
                callOptions.timeoutMs ?? HISTORY_IMAGES_TIMEOUT_MS,
                callOptions.signal,
                '读取消息图片',
                'missing'
            );
            if (!isRecord(payload) || !Array.isArray(payload.images)) {
                throw new HistoryRequestError('unavailable', '读取消息图片返回了意料之外的格式');
            }
            const items: HistoryImageItem[] = [];
            for (const raw of payload.images) {
                const item = parseImageItem(raw);
                if (item) items.push(item);
            }
            return { images: items, media: parseMedia(payload.media) };
        });
    };

    /**
     * Bytes of one archived image, kept inline in MediaCache after the first
     * download. Only successful downloads are stored; a 404 stays null and is
     * retried next time, because luoxu may still be able to produce the image.
     */
    const imageBytes = async (
        channelId: number,
        messageId: number,
        which: string,
        callOptions: { readonly thumb?: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
    ): Promise<HistoryImageBytes | null> => {
        const thumb = callOptions.thumb === true;
        const params = new URLSearchParams({ g: String(channelId), id: String(messageId), which });
        if (thumb) params.set('thumb', '1');
        const url = `${baseUrl}/message-image?${params.toString()}`;
        const download = (): Promise<HistoryImageBytes | null> =>
            callBytes(
                url,
                callOptions.timeoutMs ?? HISTORY_IMAGE_BYTES_TIMEOUT_MS,
                callOptions.signal,
                '下载消息图片'
            );

        // Unconfigured or disabled: the same call as before the cache, nothing read or written
        if (!baseUrl || !isLuoxuCacheEnabled()) return download();

        const cacheKey = historyImageCacheKey(channelId, messageId, which, thumb);
        const running = inflightHistoryImages.get(cacheKey);
        if (running !== undefined) return running;

        const load = async (): Promise<HistoryImageBytes | null> => {
            const cached = await getCachedMedia(cacheKey).catch((error: unknown) => {
                // A cache problem must not fail a read that worked without one
                console.error('[luoxu-history] failed to read the image cache:', error);
                return null;
            });
            if (cached !== null && cached.data !== null) return { data: cached.data, mime: cached.mime };

            const downloaded = await download();
            if (downloaded === null || downloaded.data.length > HISTORY_IMAGE_CACHE_MAX_BYTES) return downloaded;
            try {
                await withBusyRetry(
                    () =>
                        putCachedMedia({
                            fileUniqueId: cacheKey,
                            data: downloaded.data,
                            sizeBytes: downloaded.data.length,
                            mime: downloaded.mime,
                            kind: 'history-image',
                        }),
                    'luoxu history image'
                );
            } catch (error) {
                // Same: the bytes are already in hand, a cache write failure is not a read failure
                console.error('[luoxu-history] failed to cache image bytes:', error);
            }
            return downloaded;
        };

        const pending = load();
        inflightHistoryImages.set(cacheKey, pending);
        try {
            return await pending;
        } finally {
            if (inflightHistoryImages.get(cacheKey) === pending) inflightHistoryImages.delete(cacheKey);
        }
    };

    return { search, findSenders, messages, stats, images, imageBytes };
};
