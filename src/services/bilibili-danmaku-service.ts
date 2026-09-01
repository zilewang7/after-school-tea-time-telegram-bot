/**
 * Viewer danmaku (弹幕) for bilibili videos shared through @bilifeedbot.
 *
 * When a context message is an inline post via @bilifeedbot or a forward of
 * one and carries a video, the video's danmaku are fetched from bilibili's
 * public XML endpoint and injected as a text part, so the model sees how the
 * audience reacted along the timeline.
 *
 * Fetched at context-build time (danmaku keep accumulating after the video is
 * posted, so an ingest-time snapshot would be stale-thin for fresh videos) and
 * cached in memory by video+page. Failures never block a reply: short request
 * timeouts, a negative cache, and a cool-down after network errors.
 */
import type { UnifiedContentPart } from '../ai/types.js';

/** One video reference extracted from a message text */
export interface BilibiliVideoRef {
    /** Numeric av id, kept as a string (new-style avids are near 2^53) */
    aid: string | null;
    /** BV id including the "BV" prefix */
    bvid: string | null;
    /** 1-based part number (?p=N), defaults to 1 */
    page: number;
}

/** One parsed danmaku line */
export interface DanmakuEntry {
    /** Seconds into the video where the danmaku appears */
    timeSec: number;
    /** Server-assigned weight (1-10, higher = more representative); 0 when absent */
    weight: number;
    text: string;
}

/** The message fields the trigger condition looks at */
export interface DanmakuSourceMessage {
    text: string | null;
    viaBot: string | null;
    forwardOrigin: string | null;
    mediaHint: string | null;
}

const BILIFEED_USERNAME = '@bilifeedbot';
/** forwardOrigin stores the display name ("user Bilibili Feed Bot") */
const BILIFEED_DISPLAY_NAME = 'bilibili feed bot';

/** How many danmaku lines at most go into the context */
const MAX_DANMAKU_LINES = 200;
/** Rendered block size cap, so a wall of long danmaku cannot flood the context */
const MAX_BLOCK_CHARS = 10_000;

const REQUEST_TIMEOUT_MS = 6_000;
const SUCCESS_TTL_MS = 30 * 60 * 1000;
/** Also used for "no danmaku found", so a dead link is not re-fetched per reply */
const FAILURE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;
/** After a network error, skip all danmaku fetches for this long */
const COOL_DOWN_MS = 60 * 1000;

const BILI_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    Referer: 'https://www.bilibili.com',
};

/** `bilibili.com/video/av123` / `bilibili.com/video/BV1xx…` plus its query tail */
const VIDEO_URL_PATTERN = /bilibili\.com\/video\/(?:av(\d+)|(BV[0-9A-Za-z]{5,12}))([^\s)\]]*)/;

/** Whether the message came through @bilifeedbot (inline or forwarded) with a video */
export const isBilifeedVideoMessage = (msg: DanmakuSourceMessage): boolean => {
    const viaBilifeed = msg.viaBot?.toLowerCase() === BILIFEED_USERNAME;
    const forwardedFromBilifeed =
        msg.forwardOrigin?.toLowerCase().includes(BILIFEED_DISPLAY_NAME) ?? false;
    const hasVideo = msg.mediaHint?.includes('video') ?? false;
    return (viaBilifeed || forwardedFromBilifeed) && hasVideo;
};

/** Extract the first bilibili video reference from a message text, if any */
export const extractBilibiliVideoRef = (text: string | null): BilibiliVideoRef | null => {
    if (!text) return null;
    const matched = VIDEO_URL_PATTERN.exec(text);
    if (!matched) return null;

    const [, aid, bvid, tail] = matched;
    const pageMatch = tail ? /[?&]p=(\d+)/.exec(tail) : null;
    const page = pageMatch ? Number(pageMatch[1]) : 1;

    return {
        aid: aid ?? null,
        bvid: bvid ?? null,
        page: page >= 1 ? page : 1,
    };
};

const decodeXmlEntities = (raw: string): string =>
    raw
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

/**
 * Parse bilibili's danmaku XML (`<d p="time,mode,size,color,ts,pool,hash,id[,weight]">text</d>`).
 * Only the appearance time and the weight matter here.
 */
export const parseDanmakuXml = (xml: string): DanmakuEntry[] => {
    const entries: DanmakuEntry[] = [];
    const pattern = /<d p="([^"]*)">([^<]*)<\/d>/g;
    for (const [, attrs, body] of xml.matchAll(pattern)) {
        if (attrs === undefined || body === undefined) continue;
        const text = decodeXmlEntities(body).trim();
        if (!text) continue;
        const fields = attrs.split(',');
        const timeSec = Number(fields[0]);
        const weight = Number(fields[8] ?? 0);
        entries.push({
            timeSec: Number.isFinite(timeSec) ? timeSec : 0,
            weight: Number.isFinite(weight) ? weight : 0,
            text,
        });
    }
    return entries;
};

/**
 * Keep the most representative danmaku when over the cap (higher server weight
 * first), then restore timeline order for reading.
 */
export const selectDanmaku = (entries: DanmakuEntry[], cap: number): DanmakuEntry[] => {
    const selected =
        entries.length > cap
            ? [...entries].sort((a, b) => b.weight - a.weight).slice(0, cap)
            : entries;
    return [...selected].sort((a, b) => a.timeSec - b.timeSec);
};

const formatTimestamp = (timeSec: number): string => {
    const total = Math.max(0, Math.floor(timeSec));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/** Render the injected context block; null when there is nothing to show */
export const renderDanmakuBlock = (
    ref: BilibiliVideoRef,
    entries: DanmakuEntry[]
): string | null => {
    if (!entries.length) return null;
    const selected = selectDanmaku(entries, MAX_DANMAKU_LINES);

    const videoLabel = ref.bvid ?? `av${ref.aid}`;
    const pageLabel = ref.page > 1 ? ` P${ref.page}` : '';
    const header = `[system] 该 B 站视频（${videoLabel}${pageLabel}）的观众弹幕节选（${selected.length} 条，按视频内出现时间排序）。弹幕是观众发表的评论，反映观众反应，不代表视频本身的内容：`;
    const lines = [header];

    let totalChars = header.length;
    for (const entry of selected) {
        const line = `[${formatTimestamp(entry.timeSec)}] ${entry.text}`;
        totalChars += line.length + 1;
        if (totalChars > MAX_BLOCK_CHARS) break;
        lines.push(line);
    }
    return lines.join('\n');
};

interface PagelistPage {
    cid: number;
    page: number;
}

const isPagelistPage = (value: unknown): value is PagelistPage =>
    typeof value === 'object' &&
    value !== null &&
    'cid' in value &&
    typeof value.cid === 'number' &&
    'page' in value &&
    typeof value.page === 'number';

const fetchJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
        headers: BILI_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
};

/** Resolve the cid (danmaku pool id) of one video part; null when not found */
const resolveCid = async (ref: BilibiliVideoRef): Promise<number | null> => {
    const query = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid ?? ''}`;
    const payload = await fetchJson(`https://api.bilibili.com/x/player/pagelist?${query}`);

    if (typeof payload !== 'object' || payload === null) return null;
    if (!('code' in payload) || payload.code !== 0) return null;
    if (!('data' in payload) || !Array.isArray(payload.data)) return null;

    const pages = payload.data.filter(isPagelistPage);
    const target = pages.find((p) => p.page === ref.page) ?? pages[0];
    return target?.cid ?? null;
};

const fetchDanmakuXml = async (cid: number): Promise<string> => {
    const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
        headers: BILI_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from danmaku endpoint`);
    return res.text();
};

interface CacheEntry {
    expiresAt: number;
    block: string | null;
}

const cache = new Map<string, CacheEntry>();
let coolDownUntil = 0;

const remember = (key: string, block: string | null, ttlMs: number): void => {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, { expiresAt: Date.now() + ttlMs, block });
};

const fetchDanmakuBlock = async (ref: BilibiliVideoRef): Promise<string | null> => {
    const cid = await resolveCid(ref);
    if (cid === null) return null;
    const entries = parseDanmakuXml(await fetchDanmakuXml(cid));
    return renderDanmakuBlock(ref, entries);
};

/**
 * The context-builder entry point: the danmaku text part for one message, or
 * null when the message is not a bilifeed video / has no danmaku / fetch failed.
 */
export const getBilibiliDanmakuPart = async (
    msg: DanmakuSourceMessage
): Promise<UnifiedContentPart | null> => {
    if (!isBilifeedVideoMessage(msg)) return null;
    const ref = extractBilibiliVideoRef(msg.text);
    if (!ref) return null;

    const key = `${ref.bvid ?? `av${ref.aid}`}:p${ref.page}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.block === null ? null : { type: 'text', text: cached.block };
    }
    if (Date.now() < coolDownUntil) return null;

    try {
        const block = await fetchDanmakuBlock(ref);
        remember(key, block, block === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS);
        if (block !== null) {
            console.log(`[bili-danmaku] injected danmaku for ${key}`);
        }
        return block === null ? null : { type: 'text', text: block };
    } catch (error) {
        coolDownUntil = Date.now() + COOL_DOWN_MS;
        remember(key, null, FAILURE_TTL_MS);
        console.error(
            '[bili-danmaku] fetch failed:',
            error instanceof Error ? error.message : error
        );
        return null;
    }
};
