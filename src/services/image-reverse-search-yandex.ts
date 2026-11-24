/**
 * Yandex's image page: the upload endpoint answers with a `cbirId`, and the
 * result page is plain server-rendered HTML (no key, no cookie, no JavaScript).
 *
 * Uploads are the slow half (about 2–4s for a normal photo) and the page is the
 * only place this module trusts, and only as data: a changed layout is a parse
 * failure, never a half-filled answer. The service above it caches by bytes and
 * decides whether another engine is asked as well.
 */
import type { SniffedMediaMime } from '../ai/image-generation/image-mime.js';
import { isJsonObject } from '../shared/json-object.js';
import {
    BROWSER_HEADERS,
    ReverseSearchFailure,
    fetchOf,
    looksLikeChallenge,
    requestSignal,
    withNetworkRetry,
} from './image-reverse-search-http.js';
import { buildMultipartBody } from './image-reverse-search-multipart.js';
import { parseReverseSearchHtml } from './image-reverse-search-parse.js';
import type { ParsedReverseSearch } from './image-reverse-search-types.js';

const UPLOAD_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 1_000;

export const DEFAULT_YANDEX_ORIGIN = 'https://yandex.com';

export interface YandexClientOptions {
    readonly origin?: string;
    /** Tests point the client at a stub server */
    readonly fetchImpl?: typeof fetch;
}

export interface YandexSearchOptions {
    readonly bytes: Buffer;
    readonly mimeType: SniffedMediaMime;
    readonly signal?: AbortSignal;
}

export interface YandexClient {
    search(options: YandexSearchOptions): Promise<ParsedReverseSearch>;
}

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

export const createYandexClient = (options: YandexClientOptions = {}): YandexClient => {
    const origin = options.origin ?? DEFAULT_YANDEX_ORIGIN;
    const request = fetchOf(options.fetchImpl);
    const uploadUrl =
        `${origin}/images/search?rpt=imageview&format=json&request=` +
        encodeURIComponent(JSON.stringify({ blocks: [{ block: 'b-page_type_search-by-image__link' }] }));

    const uploadImage = async (search: YandexSearchOptions): Promise<string> => {
        const { body, contentType } = buildMultipartBody([
            { field: 'upfile', filename: 'blob', mimeType: search.mimeType, data: search.bytes },
        ]);
        const response = await request(uploadUrl, {
            method: 'POST',
            body,
            headers: {
                ...BROWSER_HEADERS,
                'content-type': contentType,
                'content-length': String(body.length),
            },
            signal: requestSignal(UPLOAD_TIMEOUT_MS, search.signal),
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

    const fetchResultPage = async (cbirId: string, signal: AbortSignal | undefined): Promise<ParsedReverseSearch> => {
        const url = `${origin}/images/search?rpt=imageview&cbir_id=${encodeURIComponent(cbirId)}`;
        const response = await request(url, {
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
        if (looksLikeChallenge(html, response.url)) {
            throw new ReverseSearchFailure('blocked', 'Yandex 返回了验证码页面。');
        }

        const parsed = parseReverseSearchHtml(html);
        if (parsed === null) {
            throw new ReverseSearchFailure('parse', 'Yandex 结果页里没有可解析的 Cbir 区块。');
        }
        return parsed;
    };

    return {
        search: async (search) => {
            const cbirId = await withNetworkRetry(() => uploadImage(search), RETRY_DELAY_MS);
            return withNetworkRetry(() => fetchResultPage(cbirId, search.signal), RETRY_DELAY_MS);
        },
    };
};
