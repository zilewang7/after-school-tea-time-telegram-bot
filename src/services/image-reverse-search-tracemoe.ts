/**
 * trace.moe: which anime, episode and moment a screenshot comes from.
 *
 * It only knows animation frames (not illustrations or avatars), so the service
 * never calls it on its own: a tool call has to name `engine='tracemoe'`. The
 * guest quota is 100 searches a day per IP with one request in flight, so the
 * client holds a cheap daily counter and a cooldown after a quota/concurrency
 * answer instead of probing the API.
 */
import { isJsonObject } from '../shared/json-object.js';
import {
    BROWSER_HEADERS,
    ReverseSearchFailure,
    fetchOf,
    looksLikeChallenge,
    requestSignal,
} from './image-reverse-search-http.js';
import type { ParsedReverseSearch, ReverseSearchSite } from './image-reverse-search-types.js';

export const DEFAULT_TRACEMOE_ORIGIN = 'https://api.trace.moe';

export interface TraceMoeLimits {
    /** A gap between two uploads; the service also allows one request at a time */
    readonly minIntervalMs: number;
    /** Guest quota per 24h, as `/me` reports it */
    readonly dailyLimit: number;
    /** A quota / concurrency answer silences the engine for this long */
    readonly circuitMs: number;
}

export const DEFAULT_TRACEMOE_LIMITS: TraceMoeLimits = {
    minIntervalMs: 1_000,
    dailyLimit: 100,
    circuitMs: 30 * 60 * 1000,
};

/** Below this the service itself says the match is most likely wrong */
const EXACT_SIMILARITY = 90;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;

export interface TraceMoeClientOptions {
    readonly origin?: string;
    readonly fetchImpl?: typeof fetch;
    readonly limits?: TraceMoeLimits;
    /** Tests move the clock instead of waiting */
    readonly now?: () => number;
}

export interface TraceMoeSearchOptions {
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly signal?: AbortSignal;
}

export interface TraceMoeClient {
    search(options: TraceMoeSearchOptions): Promise<ParsedReverseSearch>;
}

const EMPTY_FINDINGS: ParsedReverseSearch = { sites: [], sizes: [], similar: [], tags: [] };

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

/** Seconds → `1:37` / `1:02:03` */
const clockOf = (seconds: number): string => {
    const whole = Math.max(0, Math.round(seconds));
    const hours = Math.floor(whole / 3_600);
    const minutes = Math.floor((whole % 3_600) / 60);
    const rest = whole % 60;
    const pad = (value: number): string => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
};

const titleOfAnilist = (anilist: unknown): string | null => {
    if (!isJsonObject(anilist)) return null;
    const title = anilist.title;
    if (!isJsonObject(title)) return null;
    const native = typeof title.native === 'string' && title.native.trim() !== '' ? title.native.trim() : null;
    const romaji = typeof title.romaji === 'string' && title.romaji.trim() !== '' ? title.romaji.trim() : null;
    if (native !== null && romaji !== null) return native === romaji ? native : `${native}（${romaji}）`;
    return native ?? romaji;
};

const anilistIdOf = (anilist: unknown): number | null => {
    if (typeof anilist === 'number' && Number.isFinite(anilist)) return anilist;
    if (!isJsonObject(anilist)) return null;
    return numberValue(anilist.id);
};

const isAdultOf = (anilist: unknown): boolean => isJsonObject(anilist) && anilist.isAdult === true;

const siteOf = (result: Record<string, unknown>): ReverseSearchSite | null => {
    const anilistId = anilistIdOf(result.anilist);
    if (anilistId === null) return null;

    const rawSimilarity = numberValue(result.similarity);
    const similarity = rawSimilarity === null ? 0 : Math.min(100, Math.max(0, rawSimilarity * 100));
    const filename = typeof result.filename === 'string' ? result.filename.trim() : '';
    const title =
        titleOfAnilist(result.anilist) ?? (filename === '' ? `AniList ${anilistId}` : filename.replace(/\.[^.]+$/, ''));

    const episode = numberValue(result.episode) ?? numberValue(result.episode_start);
    const at = numberValue(result.at) ?? numberValue(result.from);
    const details: string[] = [];
    if (isAdultOf(result.anilist)) details.push('R-18 动画');
    if (episode !== null) details.push(`第 ${episode} 集`);
    if (at !== null) details.push(clockOf(at));
    if (filename !== '') details.push(filename);

    const image = result.image;
    return {
        engine: 'tracemoe',
        match: similarity >= EXACT_SIMILARITY ? 'exact' : 'likely',
        title,
        url: `https://anilist.co/anime/${anilistId}`,
        domain: 'anilist.co',
        description: details.join(' · '),
        similarity: Math.round(similarity * 10) / 10,
        ...(typeof image === 'string' && isHttpUrl(image) ? { imageUrl: image } : {}),
    };
};

const failureOfError = (message: string): ReverseSearchFailure => {
    if (/quota|concurrency|limit|rate|too many|exceed/i.test(message)) {
        return new ReverseSearchFailure('rate-limited', `trace.moe 暂时不可用（${message}）。`);
    }
    return new ReverseSearchFailure('parse', `trace.moe 返回错误（${message}）。`);
};

const parseJson = (body: string): unknown => {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
};

/** The search answer as the shared findings; throws when it is not one */
export const parseTraceMoeJson = (body: string): ParsedReverseSearch => {
    const parsed = parseJson(body);
    if (!isJsonObject(parsed)) {
        throw new ReverseSearchFailure('parse', 'trace.moe 返回的不是 JSON。');
    }
    const error = parsed.error;
    if (typeof error === 'string' && error.trim() !== '') throw failureOfError(error.trim());

    const results = parsed.result;
    if (results === undefined || results === null) return EMPTY_FINDINGS;
    if (!Array.isArray(results)) {
        throw new ReverseSearchFailure('parse', 'trace.moe 响应里的 result 不是数组。');
    }

    const sites: ReverseSearchSite[] = [];
    for (const entry of results) {
        if (!isJsonObject(entry)) continue;
        const site = siteOf(entry);
        if (site === null) continue;
        if (sites.some((known) => known.url === site.url)) continue;
        sites.push(site);
        if (sites.length >= MAX_RESULTS) break;
    }
    return { ...EMPTY_FINDINGS, sites };
};

const dayKeyOf = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 10);

export const createTraceMoeClient = (options: TraceMoeClientOptions = {}): TraceMoeClient => {
    const origin = options.origin ?? DEFAULT_TRACEMOE_ORIGIN;
    const limits = options.limits ?? DEFAULT_TRACEMOE_LIMITS;
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
            `[image-reverse] tracemoe circuit-open reason=${reason} until=${new Date(circuitUntil).toISOString()}`
        );
    };

    const blockReasonOf = (): ReverseSearchFailure | null => {
        const moment = now();
        if (inFlight) {
            return new ReverseSearchFailure('rate-limited', 'trace.moe 上一次请求还没有结束（并发上限 1），本次跳过。');
        }
        if (circuitUntil !== null && moment < circuitUntil) {
            return new ReverseSearchFailure('rate-limited', 'trace.moe 配额触发过冷却，本次跳过。');
        }
        resetCounterIfNeeded(moment);
        if (requestsToday >= limits.dailyLimit) {
            return new ReverseSearchFailure(
                'rate-limited',
                `trace.moe 今日请求数已达上限（${limits.dailyLimit} 次），本次跳过。`
            );
        }
        if (lastRequestAt !== null && moment - lastRequestAt < limits.minIntervalMs) {
            return new ReverseSearchFailure('rate-limited', 'trace.moe 两次请求间隔太短，本次跳过。');
        }
        return null;
    };

    const search = async (search: TraceMoeSearchOptions): Promise<ParsedReverseSearch> => {
        const blocked = blockReasonOf();
        if (blocked !== null) {
            console.log(`[image-reverse] tracemoe blocked kind=${blocked.kind} detail=${blocked.message}`);
            throw blocked;
        }

        inFlight = true;
        lastRequestAt = now();
        requestsToday += 1;
        try {
            const response = await request(`${origin}/search?anilistInfo`, {
                method: 'POST',
                body: search.bytes,
                headers: {
                    ...BROWSER_HEADERS,
                    accept: 'application/json',
                    'content-type': search.mimeType,
                    'content-length': String(search.bytes.length),
                },
                signal: requestSignal(REQUEST_TIMEOUT_MS, search.signal),
            });
            const text = await response.text();

            if (response.status === 402 || response.status === 429) {
                openCircuit(`http-${response.status}`);
                throw new ReverseSearchFailure(
                    'rate-limited',
                    `trace.moe 返回 HTTP ${response.status}（配额用尽或并发超限）。`
                );
            }
            if (response.status === 403) {
                throw new ReverseSearchFailure('blocked', 'trace.moe 返回 HTTP 403。');
            }
            if (!response.ok) {
                throw new ReverseSearchFailure(
                    response.status === 400 ? 'parse' : 'network',
                    `trace.moe 返回 HTTP ${response.status}。`
                );
            }
            if (looksLikeChallenge(text, response.url)) {
                openCircuit('challenge');
                throw new ReverseSearchFailure('blocked', 'trace.moe 返回了拦截页面。');
            }
            if (!text.trimStart().startsWith('{')) {
                throw new ReverseSearchFailure('parse', 'trace.moe 返回的不是 JSON。');
            }

            try {
                return parseTraceMoeJson(text);
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
