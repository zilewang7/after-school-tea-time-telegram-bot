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
 *
 * Every successful fetch also persists the parsed danmaku as a DB snapshot —
 * bilibili closes the danmaku pool server-side when a video is deleted and no
 * public archive covers arbitrary UGC videos, so when a live fetch comes back
 * empty-handed the last snapshot is served instead, marked as an archive.
 */
import { BiliDanmakuSnapshot } from '../db/biliDanmakuSnapshotDTO.js';
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

const videoLabelOf = (ref: BilibiliVideoRef): string =>
    `${ref.bvid ?? `av${ref.aid}`}${ref.page > 1 ? ` P${ref.page}` : ''}`;

const renderLines = (header: string, selected: DanmakuEntry[]): string => {
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

/** Render the injected context block; null when there is nothing to show */
export const renderDanmakuBlock = (
    ref: BilibiliVideoRef,
    entries: DanmakuEntry[]
): string | null => {
    if (!entries.length) return null;
    const selected = selectDanmaku(entries, MAX_DANMAKU_LINES);
    const header = `[system] 该 B 站视频（${videoLabelOf(ref)}）的观众弹幕节选（${selected.length} 条，按视频内出现时间排序）。弹幕是观众发表的评论，反映观众反应，不代表视频本身的内容：`;
    return renderLines(header, selected);
};

/** Render a persisted snapshot of a video that can no longer be fetched live */
export const renderArchivedDanmakuBlock = (
    ref: BilibiliVideoRef,
    entries: DanmakuEntry[],
    capturedAt: Date
): string | null => {
    if (!entries.length) return null;
    const selected = selectDanmaku(entries, MAX_DANMAKU_LINES);
    const capturedDate = capturedAt.toISOString().slice(0, 10);
    const header = `[system] 该 B 站视频（${videoLabelOf(ref)}）的弹幕当前无法实时获取（视频可能已失效），以下为此前抓取的弹幕存档快照（${capturedDate} 抓取，${selected.length} 条，按视频内出现时间排序）。弹幕是观众发表的评论，不代表视频本身的内容：`;
    return renderLines(header, selected);
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

/** Parsed danmaku, or null when the video is gone (pagelist knows no cid) */
const fetchDanmakuEntries = async (ref: BilibiliVideoRef): Promise<DanmakuEntry[] | null> => {
    const cid = await resolveCid(ref);
    if (cid === null) return null;
    return parseDanmakuXml(await fetchDanmakuXml(cid));
};

const videoRefKey = (ref: BilibiliVideoRef): string =>
    `${ref.bvid ?? `av${ref.aid}`}:p${ref.page}`;

/**
 * Persist the parsed danmaku as the video's archive snapshot. An empty list
 * never overwrites an existing snapshot — emptiness is what the archive is for.
 */
export const saveDanmakuSnapshot = async (
    ref: BilibiliVideoRef,
    entries: DanmakuEntry[]
): Promise<void> => {
    if (!entries.length) return;
    await BiliDanmakuSnapshot.upsert({
        videoKey: videoRefKey(ref),
        entries: JSON.stringify(entries),
        entryCount: entries.length,
        capturedAt: new Date(),
    });
};

const isDanmakuEntry = (value: unknown): value is DanmakuEntry =>
    typeof value === 'object' &&
    value !== null &&
    'timeSec' in value &&
    typeof value.timeSec === 'number' &&
    'weight' in value &&
    typeof value.weight === 'number' &&
    'text' in value &&
    typeof value.text === 'string';

/** The rendered archive snapshot for a video, or null when none was captured */
export const loadArchivedDanmakuBlock = async (
    ref: BilibiliVideoRef
): Promise<string | null> => {
    const row = await BiliDanmakuSnapshot.findByPk(videoRefKey(ref));
    if (!row) return null;
    const parsed: unknown = (() => {
        try {
            return JSON.parse(row.entries);
        } catch {
            return null;
        }
    })();
    if (!Array.isArray(parsed)) return null;
    return renderArchivedDanmakuBlock(ref, parsed.filter(isDanmakuEntry), row.capturedAt);
};

const toPart = (block: string | null): UnifiedContentPart | null =>
    block === null ? null : { type: 'text', text: block };

/**
 * The context-builder entry point: the danmaku text part for one message, or
 * null when the message is not a bilifeed video / has no danmaku anywhere.
 * A dead or empty live fetch falls back to the archive snapshot.
 */
export const getBilibiliDanmakuPart = async (
    msg: DanmakuSourceMessage
): Promise<UnifiedContentPart | null> => {
    if (!isBilifeedVideoMessage(msg)) return null;
    const ref = extractBilibiliVideoRef(msg.text);
    if (!ref) return null;

    const key = videoRefKey(ref);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return toPart(cached.block);
    }
    if (Date.now() < coolDownUntil) return null;

    try {
        const entries = await fetchDanmakuEntries(ref);
        if (entries && entries.length) {
            const block = renderDanmakuBlock(ref, entries);
            remember(key, block, SUCCESS_TTL_MS);
            saveDanmakuSnapshot(ref, entries).catch((error) => {
                console.error(
                    '[bili-danmaku] snapshot persist failed:',
                    error instanceof Error ? error.message : error
                );
            });
            console.log(`[bili-danmaku] injected danmaku for ${key}`);
            return toPart(block);
        }

        // Video deleted (no cid) or its pool is closed/empty → archive fallback
        const archived = await loadArchivedDanmakuBlock(ref);
        remember(key, archived, FAILURE_TTL_MS);
        if (archived !== null) {
            console.log(`[bili-danmaku] served archived snapshot for ${key}`);
        }
        return toPart(archived);
    } catch (error) {
        coolDownUntil = Date.now() + COOL_DOWN_MS;
        console.error(
            '[bili-danmaku] fetch failed:',
            error instanceof Error ? error.message : error
        );
        const archived = await loadArchivedDanmakuBlock(ref).catch(() => null);
        remember(key, archived, FAILURE_TTL_MS);
        return toPart(archived);
    }
};

/**
 * Ingest-time hook: capture the danmaku snapshot while the video is still
 * alive, ahead of anyone asking. Fire-and-forget; shares the pipeline (and
 * its cache/cool-down) with the context-build path.
 */
export const primeDanmakuSnapshot = (msg: DanmakuSourceMessage): void => {
    void getBilibiliDanmakuPart(msg);
};
