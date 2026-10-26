/**
 * Reverse image search through Yandex's image page.
 *
 * The upload endpoint answers with a `cbirId`; the result page is plain
 * server-rendered HTML (no key, no cookie, no JavaScript). Uploads are the slow
 * half (about 2–4s for a normal photo), so results are cached by the SHA-256 of
 * the bytes: the same meme posted twice in a chat costs one request.
 *
 * The page is also the only place this module trusts, and only as data: a
 * changed layout is a parse failure, never a half-filled answer.
 */
import { createHash } from 'node:crypto';
import type { SniffedMediaMime } from '../ai/image-generation/image-mime.js';
import { getErrorMessage, isTimeoutError } from '../shared/errors.js';
import { isJsonObject } from '../shared/json-object.js';
import { parseReverseSearchHtml, type ParsedReverseSearch } from './image-reverse-search-parse.js';

/** Telegram photos are usually below this; the upload endpoint turns flaky above it */
export const MAX_REVERSE_SEARCH_BYTES = 8 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 1_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

const YANDEX_ORIGIN = 'https://yandex.com';
const BROWSER_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
} as const;

const UPLOAD_URL =
    `${YANDEX_ORIGIN}/images/search?rpt=imageview&format=json&request=` +
    encodeURIComponent(JSON.stringify({ blocks: [{ block: 'b-page_type_search-by-image__link' }] }));

export type ReverseSearchErrorKind = 'too-large' | 'timeout' | 'aborted' | 'blocked' | 'parse' | 'network';

export interface ReverseSearchOptions {
    readonly bytes: Buffer;
    readonly mimeType: SniffedMediaMime;
    readonly signal?: AbortSignal;
}

export interface ReverseSearchStats {
    readonly uploadMs: number;
    readonly pageMs: number;
    readonly elapsedMs: number;
}

export type ReverseSearchOutcome =
    | {
          readonly ok: true;
          readonly result: ParsedReverseSearch;
          readonly cached: boolean;
          readonly stats: ReverseSearchStats;
      }
    | {
          readonly ok: false;
          readonly kind: ReverseSearchErrorKind;
          readonly error: string;
      };

type ReverseSearchFailureOutcome = Extract<ReverseSearchOutcome, { readonly ok: false }>;

class ReverseSearchFailure extends Error {
    constructor(
        readonly kind: ReverseSearchErrorKind,
        message: string
    ) {
        super(message);
        this.name = 'ReverseSearchFailure';
    }
}

interface CacheEntry {
    readonly expiresAt: number;
    readonly result: ParsedReverseSearch;
}

const cache = new Map<string, CacheEntry>();

/** Only for tests: forget everything cached */
export const clearReverseSearchCache = (): void => {
    cache.clear();
};

const cacheKeyOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const cacheGet = (key: string): ParsedReverseSearch | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    // Refresh insertion order for the LRU eviction below
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
};

const cachePut = (key: string, result: ParsedReverseSearch): void => {
    while (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
};

const requestSignal = (timeoutMs: number, outer: AbortSignal | undefined): AbortSignal =>
    outer === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);

const cbirIdOf = (value: unknown): string | null => {
    if (!isJsonObject(value)) return null;
    const blocks = value.blocks;
    if (!Array.isArray(blocks)) return null;
    const first = blocks[0];
    if (!isJsonObject(first)) return null;
    const params = first.params;
    if (!isJsonObject(params)) return null;
    return typeof params.cbirId === 'string' && params.cbirId !== '' ? params.cbirId : null;
};

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const uploadImage = async (options: ReverseSearchOptions): Promise<string> => {
    const form = new FormData();
    form.append('upfile', new Blob([new Uint8Array(options.bytes)], { type: options.mimeType }), 'blob');

    const response = await fetch(UPLOAD_URL, {
        method: 'POST',
        body: form,
        headers: BROWSER_HEADERS,
        signal: requestSignal(UPLOAD_TIMEOUT_MS, options.signal),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new ReverseSearchFailure(
            response.status === 403 || response.status === 429 ? 'blocked' : 'network',
            `Yandex 上传返回 HTTP ${response.status}。`
        );
    }

    const cbirId = cbirIdOf(parseJson(text));
    if (cbirId === null) {
        throw new ReverseSearchFailure('parse', 'Yandex 上传响应里没有 cbirId。');
    }
    return cbirId;
};

const looksLikeCaptcha = (html: string, finalUrl: string): boolean =>
    /showcaptcha/i.test(finalUrl) || /showcaptcha|smartcaptcha|Ой!/i.test(html.slice(0, 20_000));

const fetchResultPage = async (cbirId: string, signal: AbortSignal | undefined): Promise<ParsedReverseSearch> => {
    const url = `${YANDEX_ORIGIN}/images/search?rpt=imageview&cbir_id=${encodeURIComponent(cbirId)}`;
    const response = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: requestSignal(PAGE_TIMEOUT_MS, signal),
    });
    const html = await response.text();
    if (!response.ok) {
        throw new ReverseSearchFailure(
            response.status === 403 || response.status === 429 ? 'blocked' : 'network',
            `Yandex 结果页返回 HTTP ${response.status}。`
        );
    }
    if (looksLikeCaptcha(html, response.url)) {
        throw new ReverseSearchFailure('blocked', 'Yandex 返回了验证码页面。');
    }

    const parsed = parseReverseSearchHtml(html);
    if (parsed === null) {
        throw new ReverseSearchFailure('parse', 'Yandex 结果页里没有可解析的 Cbir 区块。');
    }
    return parsed;
};

const causeCodeOf = (error: unknown): string | undefined => {
    if (!(error instanceof Error)) return undefined;
    const cause = error.cause;
    if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
    return typeof cause.code === 'string' ? cause.code : undefined;
};

const isAbortLike = (error: unknown): boolean =>
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || isTimeoutError(error));

const isNetworkFailure = (error: unknown): boolean => {
    if (error instanceof TypeError) return true;
    const code = causeCodeOf(error);
    return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
};

const shouldRetry = (error: unknown): boolean => {
    if (error instanceof ReverseSearchFailure) return error.kind === 'network';
    return !isAbortLike(error) && isNetworkFailure(error);
};

const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
        return await operation();
    } catch (error) {
        if (!shouldRetry(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return operation();
    }
};

const failureOf = (error: unknown, signal: AbortSignal | undefined): ReverseSearchFailureOutcome => {
    if (error instanceof ReverseSearchFailure) {
        return { ok: false, kind: error.kind, error: error.message };
    }
    if (isAbortLike(error)) {
        return signal?.aborted === true
            ? { ok: false, kind: 'aborted', error: '以图搜图请求已取消。' }
            : { ok: false, kind: 'timeout', error: '以图搜图超时：Yandex 没有在限定时间内返回。' };
    }
    return { ok: false, kind: 'network', error: `以图搜图请求失败：${getErrorMessage(error)}` };
};

const summaryOf = (result: ParsedReverseSearch): string =>
    `sites=${result.sites.length} sizes=${result.sizes.length} similar=${result.similar.length} tags=${result.tags.length}`;

/**
 * One reverse search. `cached` hits skip both requests; `stats` are wall-clock
 * milliseconds so the tool can show how long the model waited.
 */
export const searchByImage = async (options: ReverseSearchOptions): Promise<ReverseSearchOutcome> => {
    const { bytes, mimeType, signal } = options;
    if (bytes.length > MAX_REVERSE_SEARCH_BYTES) {
        const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
        return {
            ok: false,
            kind: 'too-large',
            error: `图片 ${megabytes}MB，超过以图搜图上限 ${MAX_REVERSE_SEARCH_BYTES / (1024 * 1024)}MB。`,
        };
    }

    const key = cacheKeyOf(bytes);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`[image-reverse] cache-hit bytes=${bytes.length} ${summaryOf(cached)}`);
        return {
            ok: true,
            result: cached,
            cached: true,
            stats: { uploadMs: 0, pageMs: 0, elapsedMs: 0 },
        };
    }

    const startedAt = Date.now();
    try {
        const uploadStartedAt = Date.now();
        const cbirId = await withRetry(() => uploadImage(options));
        const uploadMs = Date.now() - uploadStartedAt;

        const pageStartedAt = Date.now();
        const result = await withRetry(() => fetchResultPage(cbirId, signal));
        const pageMs = Date.now() - pageStartedAt;
        const elapsedMs = Date.now() - startedAt;

        cachePut(key, result);
        console.log(
            `[image-reverse] ok bytes=${bytes.length} mime=${mimeType} upload=${uploadMs} ` +
                `page=${pageMs} elapsed=${elapsedMs} ${summaryOf(result)}`
        );
        return { ok: true, result, cached: false, stats: { uploadMs, pageMs, elapsedMs } };
    } catch (error) {
        const outcome = failureOf(error, signal);
        console.log(`[image-reverse] failed kind=${outcome.kind} bytes=${bytes.length} detail=${outcome.error}`);
        return outcome;
    }
};
