/**
 * SauceNAO's JSON API v2 (a registered account's `api_key`): the picture is
 * posted to `/search.php` and the visible results come back as JSON with a
 * similarity score and the source fields of the matching gallery (Pixiv, X,
 * Danbooru, yande.re, …). It is the supplement to Yandex for anime and
 * illustrations, where Yandex only knows repost pages.
 *
 * The free account's quota has no reliable public numbers, so the client paces
 * itself: a minimum gap between requests, a conservative daily cap and a
 * cooldown after a 429 or a Cloudflare wall. A blocked request is a normal
 * degrade for the caller — never a reason to fail the whole search.
 */
import { isJsonObject } from '../shared/json-object.js';
import {
    BROWSER_HEADERS,
    ReverseSearchFailure,
    fetchOf,
    looksLikeChallenge,
    requestSignal,
} from './image-reverse-search-http.js';
import { buildMultipartBody } from './image-reverse-search-multipart.js';
import type {
    ParsedReverseSearch,
    ReverseSearchSite,
} from './image-reverse-search-types.js';

/** A visible result at or above this similarity is the exact picture */
export const SAUCENAO_EXACT_SIMILARITY = 85;
/** Below this similarity a result is noise: the API's own floor is around 40–50 */
export const SAUCENAO_LIKELY_SIMILARITY = 70;

export const DEFAULT_SAUCENAO_ORIGIN = 'https://saucenao.com';

export interface SauceNaoLimits {
    /** Minimum gap between two requests; the account's short limit is per 30s */
    readonly minIntervalMs: number;
    /** Requests a day; kept well below the account's real limit */
    readonly dailyLimit: number;
    /** A 429 / captcha wall silences the engine for this long */
    readonly circuitMs: number;
}

export const DEFAULT_SAUCENAO_LIMITS: SauceNaoLimits = {
    minIntervalMs: 10_000,
    dailyLimit: 50,
    circuitMs: 30 * 60 * 1000,
};

const REQUEST_TIMEOUT_MS = 15_000;
const NUM_RESULTS = 5;
const DATABASE_ALL = '999';
const MAX_SITES = 10;

export interface SauceNaoClientOptions {
    /** The registered account's key; empty = the engine is not configured */
    readonly apiKey: string;
    readonly origin?: string;
    readonly fetchImpl?: typeof fetch;
    readonly limits?: SauceNaoLimits;
    /** Tests move the clock instead of waiting */
    readonly now?: () => number;
}

export interface SauceNaoSearchOptions {
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly signal?: AbortSignal;
    /** true sends `hide=3`: only Known Safe gallery results */
    readonly safe: boolean;
}

export interface SauceNaoClient {
    search(options: SauceNaoSearchOptions): Promise<ParsedReverseSearch>;
}

const EMPTY_FINDINGS: ParsedReverseSearch = { sites: [], sizes: [], similar: [], tags: [] };

const textValue = (data: Record<string, unknown>, key: string): string | null => {
    const value = data[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
};

const idValue = (data: Record<string, unknown>, key: string): string | null => {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    return null;
};

const numberValue = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const domainOf = (rawUrl: string): string => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
};

/** The page a result points at when the API did not send `ext_urls` for it */
const fallbackUrlOf = (data: Record<string, unknown>): string | null => {
    const pixiv = idValue(data, 'pixiv_id');
    if (pixiv !== null) return `https://www.pixiv.net/artworks/${pixiv}`;

    const tweet = idValue(data, 'tweet_id');
    if (tweet !== null) {
        const handle = textValue(data, 'twitter_user_handle');
        return handle === null ? `https://x.com/i/status/${tweet}` : `https://x.com/${handle}/status/${tweet}`;
    }

    const danbooru = idValue(data, 'danbooru_id');
    if (danbooru !== null) return `https://danbooru.donmai.us/posts/${danbooru}`;
    const yandere = idValue(data, 'yandere_id');
    if (yandere !== null) return `https://yande.re/post/show/${yandere}`;
    const gelbooru = idValue(data, 'gelbooru_id');
    if (gelbooru !== null) return `https://gelbooru.com/index.php?page=post&s=view&id=${gelbooru}`;
    const sankaku = idValue(data, 'sankaku_id');
    if (sankaku !== null) return `https://chan.sankakucomplex.com/post/show/${sankaku}`;
    const konachan = idValue(data, 'konachan_id');
    if (konachan !== null) return `https://konachan.com/post/show/${konachan}`;
    const seiga = idValue(data, 'seiga_id');
    if (seiga !== null) return `https://seiga.nicovideo.jp/seiga/im${seiga}`;
    const anidb = idValue(data, 'anidb_aid');
    if (anidb !== null) return `https://anidb.net/anime/${anidb}`;
    const e621 = idValue(data, 'e621_id');
    if (e621 !== null) return `https://e621.net/posts/${e621}`;
    return null;
};

/** The page worth linking first: the original source when the gallery states it */
const urlOf = (data: Record<string, unknown>): string | null => {
    const source = textValue(data, 'source');
    const candidates: string[] = [];
    if (source !== null) {
        const embedded = /https?:\/\/\S+/.exec(source);
        if (embedded !== null) candidates.push(embedded[0]);
    }
    const extUrls = data.ext_urls;
    if (Array.isArray(extUrls)) {
        for (const entry of extUrls) {
            if (typeof entry === 'string') candidates.push(entry);
        }
    }
    const direct = textValue(data, 'url');
    if (direct !== null) candidates.push(direct);

    for (const candidate of candidates) {
        if (isHttpUrl(candidate)) return candidate;
    }
    return fallbackUrlOf(data);
};

const CREATOR_KEYS = ['creator', 'creator_name', 'member_name', 'author_name', 'artist', 'user_name'] as const;

const creatorOf = (data: Record<string, unknown>): string | null => {
    for (const key of CREATOR_KEYS) {
        const value = textValue(data, key);
        if (value !== null) return value;
    }
    return null;
};

const titleOf = (data: Record<string, unknown>, indexName: string): string => {
    const artwork = textValue(data, 'title') ?? textValue(data, 'eng_name') ?? textValue(data, 'jp_name');
    const creator = creatorOf(data);
    if (artwork !== null && creator !== null) return `${artwork}（${creator}）`;
    if (artwork !== null) return artwork;
    if (creator !== null) return creator;

    const handle = textValue(data, 'twitter_user_handle');
    if (handle !== null) return `@${handle}`;
    return indexName === '' ? 'SauceNAO 结果' : indexName;
};

const descriptionOf = (data: Record<string, unknown>, indexName: string): string => {
    const details: string[] = [];
    if (indexName !== '') details.push(indexName);
    const material = textValue(data, 'material');
    if (material !== null) details.push(`作品: ${material}`);
    const characters = textValue(data, 'characters');
    if (characters !== null) details.push(`角色: ${characters}`);
    const source = textValue(data, 'source');
    if (source !== null && !/^https?:\/\//i.test(source)) details.push(`来源: ${source}`);
    return details.join(' · ');
};

const siteOf = (header: Record<string, unknown>, data: Record<string, unknown>): ReverseSearchSite | null => {
    if (header.hidden === 1) return null;
    const similarity = numberValue(header.similarity);
    if (similarity === null || similarity < SAUCENAO_LIKELY_SIMILARITY) return null;

    const url = urlOf(data);
    if (url === null) return null;

    const indexName = typeof header.index_name === 'string' ? header.index_name.trim() : '';
    return {
        engine: 'saucenao',
        match: similarity >= SAUCENAO_EXACT_SIMILARITY ? 'exact' : 'likely',
        title: titleOf(data, indexName),
        url,
        domain: domainOf(url),
        description: descriptionOf(data, indexName),
        similarity: Math.round(similarity * 10) / 10,
        ...(isHttpUrl(String(header.thumbnail ?? '')) ? { imageUrl: String(header.thumbnail) } : {}),
    };
};

const failureOfStatus = (status: number, message: string): ReverseSearchFailure => {
    const detail = message === '' ? `status ${status}` : `status ${status}：${message}`;
    if (/api key|anonymous|permit|invalid/i.test(message)) {
        return new ReverseSearchFailure('unconfigured', `SauceNAO 拒绝了请求（${detail}），需要有效的 SAUCENAO_API_KEY。`);
    }
    if (/rate|limit|quota|busy|queue|too many|exceed/i.test(message)) {
        return new ReverseSearchFailure('rate-limited', `SauceNAO 暂时不可用（${detail}）。`);
    }
    if (status > 0) {
        return new ReverseSearchFailure('network', `SauceNAO 服务端返回错误（${detail}）。`);
    }
    return new ReverseSearchFailure('blocked', `SauceNAO 拒绝了请求（${detail}）。`);
};

const parseJson = (body: string): unknown => {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
};

/** The JSON API's answer as the shared findings; throws when it is not one */
export const parseSauceNaoJson = (body: string): ParsedReverseSearch => {
    const parsed = parseJson(body);
    if (!isJsonObject(parsed)) {
        throw new ReverseSearchFailure('parse', 'SauceNAO 返回的不是 JSON。');
    }
    const header = parsed.header;
    if (!isJsonObject(header)) {
        throw new ReverseSearchFailure('parse', 'SauceNAO 响应里没有 header。');
    }
    const status = numberValue(header.status) ?? 0;
    const message = typeof header.message === 'string' ? header.message : '';
    if (status !== 0) throw failureOfStatus(status, message);

    const results = parsed.results;
    if (results === undefined || results === null) return EMPTY_FINDINGS;
    if (!Array.isArray(results)) {
        throw new ReverseSearchFailure('parse', 'SauceNAO 响应里的 results 不是数组。');
    }

    const sites: ReverseSearchSite[] = [];
    for (const entry of results) {
        if (!isJsonObject(entry)) continue;
        const resultHeader = entry.header;
        const data = entry.data;
        if (!isJsonObject(resultHeader) || !isJsonObject(data)) continue;
        const site = siteOf(resultHeader, data);
        if (site === null) continue;
        if (sites.some((known) => known.url === site.url)) continue;
        sites.push(site);
        if (sites.length >= MAX_SITES) break;
    }
    return { ...EMPTY_FINDINGS, sites };
};

const dayKeyOf = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 10);

const imageExtension = (mimeType: string): string => {
    const subtype = mimeType.split('/')[1] ?? 'jpeg';
    return subtype === 'jpeg' ? 'jpg' : subtype;
};

export const createSauceNaoClient = (options: SauceNaoClientOptions): SauceNaoClient => {
    const apiKey = options.apiKey.trim();
    const origin = options.origin ?? DEFAULT_SAUCENAO_ORIGIN;
    const limits = options.limits ?? DEFAULT_SAUCENAO_LIMITS;
    const request = fetchOf(options.fetchImpl);
    const now = options.now ?? Date.now;

    let lastRequestAt: number | null = null;
    let requestsToday = 0;
    let counterDay = dayKeyOf(now());
    let circuitUntil: number | null = null;
    let inFlight = false;

    const resetCounterIfNeeded = (moment: number): void => {
        const day = dayKeyOf(moment);
        if (day !== counterDay) {
            counterDay = day;
            requestsToday = 0;
        }
    };

    const openCircuit = (reason: string): void => {
        circuitUntil = now() + limits.circuitMs;
        console.log(
            `[image-reverse] saucenao circuit-open reason=${reason} until=${new Date(circuitUntil).toISOString()}`
        );
    };

    /** Why this request must not go out; null when it may */
    const blockReasonOf = (): ReverseSearchFailure | null => {
        if (apiKey === '') {
            return new ReverseSearchFailure('unconfigured', 'SauceNAO 图库检索需要 SAUCENAO_API_KEY，当前没有配置。');
        }
        const moment = now();
        if (inFlight) {
            return new ReverseSearchFailure('rate-limited', 'SauceNAO 上一次请求还没有结束，本次跳过。');
        }
        if (circuitUntil !== null && moment < circuitUntil) {
            return new ReverseSearchFailure('rate-limited', 'SauceNAO 触发过限流，正在冷却，本次跳过补充检索。');
        }
        resetCounterIfNeeded(moment);
        if (requestsToday >= limits.dailyLimit) {
            return new ReverseSearchFailure(
                'rate-limited',
                `SauceNAO 今日请求数已达上限（${limits.dailyLimit} 次），本次跳过补充检索。`
            );
        }
        if (lastRequestAt !== null && moment - lastRequestAt < limits.minIntervalMs) {
            return new ReverseSearchFailure('rate-limited', 'SauceNAO 两次请求间隔太短，本次跳过补充检索。');
        }
        return null;
    };

    const search = async (search: SauceNaoSearchOptions): Promise<ParsedReverseSearch> => {
        const blocked = blockReasonOf();
        if (blocked !== null) {
            console.log(`[image-reverse] saucenao blocked kind=${blocked.kind} detail=${blocked.message}`);
            throw blocked;
        }

        const moment = now();
        inFlight = true;
        lastRequestAt = moment;
        requestsToday += 1;

        // The JSON API takes its options as query parameters (official docs, and
        // the anonymous probe in the design doc was answered this way); only the
        // picture rides in the multipart body. The query is never logged.
        const query = new URLSearchParams({
            api_key: apiKey,
            output_type: '2',
            numres: String(NUM_RESULTS),
            db: DATABASE_ALL,
            hide: search.safe ? '3' : '0',
        });
        const { body, contentType } = buildMultipartBody([
            {
                field: 'file',
                filename: `image.${imageExtension(search.mimeType)}`,
                mimeType: search.mimeType,
                data: search.bytes,
            },
        ]);

        try {
            const response = await request(`${origin}/search.php?${query.toString()}`, {
                method: 'POST',
                body,
                headers: {
                    ...BROWSER_HEADERS,
                    accept: 'application/json',
                    'content-type': contentType,
                    'content-length': String(body.length),
                },
                signal: requestSignal(REQUEST_TIMEOUT_MS, search.signal),
            });
            const text = await response.text();

            if (response.status === 429) {
                openCircuit('http-429');
                throw new ReverseSearchFailure('rate-limited', 'SauceNAO 返回 HTTP 429（请求过于频繁）。');
            }
            if (response.status === 403 || response.status === 503) {
                openCircuit(`http-${response.status}`);
                throw new ReverseSearchFailure(
                    'blocked',
                    looksLikeChallenge(text, response.url)
                        ? 'SauceNAO 返回了 Cloudflare 验证页面。'
                        : `SauceNAO 返回 HTTP ${response.status}（被站点拦截或服务不可用）。`
                );
            }
            if (!response.ok) {
                throw new ReverseSearchFailure(
                    response.status >= 500 ? 'network' : 'blocked',
                    `SauceNAO 返回 HTTP ${response.status}。`
                );
            }
            if (looksLikeChallenge(text, response.url)) {
                openCircuit('challenge');
                throw new ReverseSearchFailure('blocked', 'SauceNAO 返回了 Cloudflare 验证页面。');
            }
            if (!text.trimStart().startsWith('{')) {
                throw new ReverseSearchFailure('parse', 'SauceNAO 返回的不是 JSON。');
            }

            try {
                return parseSauceNaoJson(text);
            } catch (error) {
                if (error instanceof ReverseSearchFailure && error.kind === 'rate-limited') openCircuit('api-limit');
                throw error;
            }
        } finally {
            inFlight = false;
        }
    };

    return { search };
};
