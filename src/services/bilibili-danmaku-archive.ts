/**
 * Internet Archive fallback for danmaku of deleted bilibili videos.
 *
 * STWP's biliarchiver uploads videos to archive.org as items named
 * `BiliBili-{bvid}_pN-{suffix}`, tagged `external-identifier:
 * urn:bilibili:video:bvid:{bvid}` — so a deleted video can be looked up by
 * bvid and its danmaku recovered. Newer items carry the danmaku as bilibili's
 * native XML (`….danmaku.xml`, weight preserved), older ones only as an ASS
 * subtitle (`…-弹幕.ass`); this module fetches the file, the service parses
 * it. Coverage is volunteer-driven (~110k items, skewed toward at-risk
 * content), so a hit is a lucky bonus, never something to rely on.
 */
import type { BilibiliVideoRef, DanmakuEntry } from './bilibili-danmaku-service.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Refuse to download a danmaku file bigger than this (metadata-reported size) */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// The public av<->bv conversion algorithm (bilibili-API-collect, misc/bvid_desc)
const XOR_CODE = 23442827791579n;
const MAX_AID = 1n << 51n;
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
const BASE = BigInt(ALPHABET.length);

/** Convert a numeric avid to its BV id, offline. Null for malformed input. */
export const avToBv = (aid: string): string | null => {
    if (!/^\d+$/.test(aid)) return null;
    const bytes = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0'];
    let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
    for (let i = bytes.length - 1; i > 2 && tmp > 0n; i -= 1) {
        bytes[i] = ALPHABET[Number(tmp % BASE)] ?? '0';
        tmp /= BASE;
    }
    [bytes[3], bytes[9]] = [bytes[9] ?? '0', bytes[3] ?? '0'];
    [bytes[4], bytes[7]] = [bytes[7] ?? '0', bytes[4] ?? '0'];
    return bytes.join('');
};

const assTimeToSeconds = (h: string, m: string, s: string, cs: string): number =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100;

/**
 * Parse danmaku out of a biliarchiver ASS file: one Dialogue line per danmaku,
 * start time = appearance time, override blocks (`{\move…}`) stripped from the
 * text. Weight is unknown in ASS, so every entry gets 0.
 */
export const parseAssDanmaku = (ass: string): DanmakuEntry[] => {
    const entries: DanmakuEntry[] = [];
    for (const line of ass.split('\n')) {
        if (!line.startsWith('Dialogue:')) continue;
        const fields = line.split(',');
        if (fields.length < 10) continue;
        const startMatch = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(fields[1]?.trim() ?? '');
        if (!startMatch) continue;
        const [, h, m, s, cs] = startMatch;
        const text = fields
            .slice(9)
            .join(',')
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\N/g, ' ')
            .trim();
        if (!text) continue;
        entries.push({
            timeSec: assTimeToSeconds(h ?? '0', m ?? '0', s ?? '0', cs ?? '0'),
            weight: 0,
            text,
        });
    }
    return entries;
};

const fetchJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
};

/** Identifiers of the archive items holding this bvid, best page match first */
const searchArchiveItems = async (bvid: string, page: number): Promise<string[]> => {
    const query = encodeURIComponent(`external-identifier:"urn:bilibili:video:bvid:${bvid}"`);
    const payload = await fetchJson(
        `https://archive.org/advancedsearch.php?q=${query}&fl[]=identifier&rows=10&output=json`
    );

    if (typeof payload !== 'object' || payload === null || !('response' in payload)) return [];
    const { response } = payload;
    if (typeof response !== 'object' || response === null || !('docs' in response)) return [];
    if (!Array.isArray(response.docs)) return [];

    const identifiers = response.docs
        .map((doc: unknown) =>
            typeof doc === 'object' && doc !== null && 'identifier' in doc &&
            typeof doc.identifier === 'string'
                ? doc.identifier
                : null
        )
        .filter((id): id is string => id !== null);

    // One item per video part; prefer the requested part
    return identifiers.sort((a, b) => {
        const aMatch = a.includes(`_p${page}-`) ? 0 : 1;
        const bMatch = b.includes(`_p${page}-`) ? 0 : 1;
        return aMatch - bMatch;
    });
};

/** Whether the video already has any item on the Archive (search only) */
export const hasArchiveOrgItem = async (bvid: string): Promise<boolean> =>
    (await searchArchiveItems(bvid, 1)).length > 0;

interface ArchiveDanmakuFile {
    name: string;
    kind: 'xml' | 'ass';
    sizeBytes: number;
}

interface ArchiveItemInfo {
    danmakuFile: ArchiveDanmakuFile | null;
    archivedAt: Date;
}

/** Naming has varied across biliarchiver versions; XML beats ASS (weight kept) */
const danmakuFileKind = (name: string): 'xml' | 'ass' | null => {
    if (name.endsWith('.danmaku.xml')) return 'xml';
    if (name.endsWith('danmaku.ass') || name.endsWith('弹幕.ass')) return 'ass';
    return null;
};

const readArchiveItem = async (identifier: string): Promise<ArchiveItemInfo | null> => {
    const payload = await fetchJson(`https://archive.org/metadata/${identifier}`);
    if (typeof payload !== 'object' || payload === null || !('files' in payload)) return null;
    if (!Array.isArray(payload.files)) return null;

    let danmakuFile: ArchiveDanmakuFile | null = null;
    for (const file of payload.files) {
        if (typeof file !== 'object' || file === null) continue;
        if (!('name' in file) || typeof file.name !== 'string') continue;
        const kind = danmakuFileKind(file.name);
        if (kind === null) continue;
        if (danmakuFile && !(kind === 'xml' && danmakuFile.kind === 'ass')) continue;
        const sizeBytes =
            'size' in file && typeof file.size === 'string' ? Number(file.size) : 0;
        danmakuFile = { name: file.name, kind, sizeBytes };
    }

    const publicdate =
        'metadata' in payload &&
        typeof payload.metadata === 'object' &&
        payload.metadata !== null &&
        'publicdate' in payload.metadata &&
        typeof payload.metadata.publicdate === 'string'
            ? new Date(payload.metadata.publicdate)
            : new Date();

    return {
        danmakuFile,
        archivedAt: Number.isNaN(publicdate.getTime()) ? new Date() : publicdate,
    };
};

const downloadDanmakuFile = async (identifier: string, fileName: string): Promise<string> => {
    const res = await fetch(
        `https://archive.org/download/${identifier}/${encodeURIComponent(fileName)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${fileName}`);
    return res.text();
};

export interface ArchivedDanmakuFileContent {
    kind: 'xml' | 'ass';
    content: string;
    archivedAt: Date;
}

/**
 * Look the video up on the Internet Archive and pull its danmaku file, or null
 * when it was never archived there. Parsing is the caller's job (keeps this
 * module free of a cyclic import on the service); errors are theirs to swallow.
 */
export const fetchArchiveOrgDanmakuFile = async (
    ref: BilibiliVideoRef
): Promise<ArchivedDanmakuFileContent | null> => {
    const bvid = ref.bvid ?? (ref.aid === null ? null : avToBv(ref.aid));
    if (bvid === null) return null;

    const identifiers = await searchArchiveItems(bvid, ref.page);
    for (const identifier of identifiers.slice(0, 2)) {
        const item = await readArchiveItem(identifier);
        if (!item?.danmakuFile) continue;
        if (item.danmakuFile.sizeBytes > MAX_FILE_BYTES) continue;

        const content = await downloadDanmakuFile(identifier, item.danmakuFile.name);
        return { kind: item.danmakuFile.kind, content, archivedAt: item.archivedAt };
    }
    return null;
};
