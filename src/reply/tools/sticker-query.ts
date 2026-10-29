/**
 * One resolver for both sticker tools: a pack index, an actual picture name,
 * or an `st1` the model already previewed.
 *
 * The misleading original filenames are not aliases. A model that asks for
 * "戴黄色猫帽" must be told what the picture actually shows, not handed a
 * sticker whose name promises a hat the drawing does not have.
 */
import {
    findStickerByPackIndex,
    normalizeStickerQuery,
    searchStickersByLabel,
    STICKER_CATALOG,
    type StickerCatalogEntry,
} from '../../services/sticker-catalog.js';
import type { ReplyMediaState } from './reply-media-state.js';

export type StickerQueryResult =
    | { readonly ok: true; readonly entry: StickerCatalogEntry }
    | { readonly ok: false; readonly error: string };

/** Original names whose picture says something else; value = the pack index that picture is */
const MISLEADING_NAMES: ReadonlyMap<string, number> = new Map([
    ['新年橘子顶头', 5],
    ['系蝴蝶结叼棒棒糖', 8],
    ['戴皇冠斗篷', 17],
    ['恶魔角翅膀', 24],
    ['戴黄色猫帽', 42],
    ['天使光环翅膀', 52],
    ['戴螃蟹帽', 63],
]);

/** Never part of the pack: the author has not uploaded it */
const MISSING_NAMES: ReadonlySet<string> = new Set(['戴蓝黑条纹帽']);

const FETCHED_ID_PATTERN = /^st\d+$/;
const INDEX_PATTERN = /^#?\d+$/;

export const padPackIndex = (packIndex: number): string => String(packIndex).padStart(2, '0');

const distance = (left: string, right: string): number => {
    const a = Array.from(left);
    const b = Array.from(right);
    const rows = a.length + 1;
    const columns = b.length + 1;
    const dp = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
    for (let i = 0; i < rows; i += 1) dp[i]![0] = i;
    for (let j = 0; j < columns; j += 1) dp[0]![j] = j;
    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < columns; j += 1) {
            const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i]![j] = Math.min(
                (dp[i - 1]![j] ?? 0) + 1,
                (dp[i]![j - 1] ?? 0) + 1,
                (dp[i - 1]![j - 1] ?? 0) + substitution
            );
        }
    }
    return dp[a.length]![b.length] ?? 0;
};

const suggestionsOf = (query: string): string => {
    const ranked = STICKER_CATALOG.map((entry) => ({ entry, distance: distance(query, entry.label) }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 3);
    return ranked.map(({ entry }) => `${padPackIndex(entry.packIndex)} ${entry.label}`).join('、');
};

const misleadingError = (
    normalized: string
): { readonly ok: false; readonly error: string } | null => {
    const packIndex = MISLEADING_NAMES.get(normalized);
    if (packIndex !== undefined) {
        const label = findStickerByPackIndex(packIndex)?.label ?? '';
        return {
            ok: false,
            error:
                `“${normalized}”这个原名和画面对不上；实际画面叫 ${padPackIndex(packIndex)} ` +
                `${label}。请用实际名称或包内序号。`,
        };
    }
    if (MISSING_NAMES.has(normalized)) {
        return {
            ok: false,
            error: '“戴蓝黑条纹帽”没有收进这个贴纸包，发不了；等作者补包后再加。',
        };
    }
    return null;
};

/** A catalog line copied whole: `30刘海遮眼低落`, `30 刘海遮眼低落`, `#30_刘海遮眼低落` */
const CATALOG_ENTRY_PATTERN = /^#?(\d{1,3})[\s、.．·_＿-]*(\S[\s\S]*)$/u;

/**
 * The name half of a query. `raw` is what the model typed and is echoed in
 * every error; `expectedIndex` is set when the query started with a pack
 * number, so a number that names a different picture than the name does is
 * refused instead of silently picking one of them.
 */
const resolveByName = (text: string, raw: string, expectedIndex?: number): StickerQueryResult => {
    const normalized = normalizeStickerQuery(text);
    const misleading = misleadingError(normalized);
    if (misleading) return misleading;

    const matches = searchStickersByLabel(text);
    const first = matches[0];
    if (matches.length === 1 && first) {
        if (expectedIndex === undefined || expectedIndex === first.packIndex) {
            return { ok: true, entry: first };
        }
        const numbered = findStickerByPackIndex(expectedIndex);
        return {
            ok: false,
            error:
                `“${raw}”里的序号和名称不是同一张：${expectedIndex} 是 ` +
                `${numbered ? `${padPackIndex(numbered.packIndex)} ${numbered.label}` : '包内没有这张'}，` +
                `${padPackIndex(first.packIndex)} 才是“${first.label}”。`,
        };
    }
    if (matches.length > 1) {
        return {
            ok: false,
            error:
                `“${raw}”对应多张：` +
                `${matches.map((entry) => `${padPackIndex(entry.packIndex)} ${entry.label}`).join('、')}；` +
                '请用序号或更完整的名称。',
        };
    }
    return {
        ok: false,
        error: `没有叫“${raw}”的贴纸。最接近的是：${suggestionsOf(normalized)}。`,
    };
};

export const resolveStickerQuery = (
    raw: string,
    state: Pick<ReplyMediaState, 'fetchedStickers'>
): StickerQueryResult => {
    const trimmed = raw.trim();
    if (trimmed === '') return { ok: false, error: 'sticker 不能为空' };

    const fetchedId = trimmed.toLowerCase();
    if (FETCHED_ID_PATTERN.test(fetchedId)) {
        const packIndex = state.fetchedStickers.get(fetchedId);
        if (packIndex === undefined) {
            return { ok: false, error: `没有预览过 ${fetchedId}；先用 fetch_image(sticker='…') 看一张。` };
        }
        const entry = findStickerByPackIndex(packIndex);
        return entry ? { ok: true, entry } : { ok: false, error: '贴纸目录里找不到这张。' };
    }

    if (INDEX_PATTERN.test(trimmed)) {
        const packIndex = Number.parseInt(trimmed.replace(/^#/, ''), 10);
        const entry = findStickerByPackIndex(packIndex);
        if (entry) return { ok: true, entry };
        return { ok: false, error: `没有第 ${packIndex} 张；包内序号是 01–72。` };
    }

    // The catalog prints `30刘海遮眼低落`, so a model copies that line as one value
    const catalogEntry = CATALOG_ENTRY_PATTERN.exec(trimmed);
    if (catalogEntry) {
        const packIndex = Number.parseInt(catalogEntry[1] ?? '', 10);
        const rest = (catalogEntry[2] ?? '').trim();
        if (rest !== '') return resolveByName(rest, trimmed, packIndex);
    }

    return resolveByName(trimmed, trimmed);
};
