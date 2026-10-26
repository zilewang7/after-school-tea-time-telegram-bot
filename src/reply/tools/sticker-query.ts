/**
 * One resolver for both sticker tools: a pack index, an actual picture name,
 * or an `st1` the model already previewed.
 *
 * The misleading original filenames are not aliases. A model that asks for
 * "戴黄色猫帽" must be told the picture is "托腮甜笑", not handed a sticker
 * whose name promises a hat the drawing does not have.
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

/** Original names whose picture says something else; value = the real label */
const MISLEADING_NAMES: ReadonlyMap<string, { packIndex: number; label: string }> = new Map([
    ['新年橘子顶头', { packIndex: 5, label: '趴白枕' }],
    ['系蝴蝶结叼棒棒糖', { packIndex: 8, label: '半睁眼抬手' }],
    ['戴皇冠斗篷', { packIndex: 17, label: '端坐露齿笑' }],
    ['恶魔角翅膀', { packIndex: 24, label: '托腮自信笑' }],
    ['戴黄色猫帽', { packIndex: 42, label: '托腮甜笑' }],
    ['天使光环翅膀', { packIndex: 52, label: '单手贴脸笑' }],
    ['戴螃蟹帽', { packIndex: 63, label: '合掌托腮' }],
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
    const misleading = MISLEADING_NAMES.get(normalized);
    if (misleading) {
        return {
            ok: false,
            error:
                `“${normalized}”这个原名和画面对不上；实际画面叫 ${padPackIndex(misleading.packIndex)} ` +
                `${misleading.label}。请用实际名称或包内序号。`,
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

    const normalized = normalizeStickerQuery(trimmed);
    const misleading = misleadingError(normalized);
    if (misleading) return misleading;

    const matches = searchStickersByLabel(trimmed);
    const first = matches[0];
    if (matches.length === 1 && first) return { ok: true, entry: first };
    if (matches.length > 1) {
        return {
            ok: false,
            error:
                `“${trimmed}”对应多张：` +
                `${matches.map((entry) => `${padPackIndex(entry.packIndex)} ${entry.label}`).join('、')}；` +
                '请用序号或更完整的名称。',
        };
    }
    return {
        ok: false,
        error: `没有叫“${trimmed}”的贴纸。最接近的是：${suggestionsOf(normalized)}。`,
    };
};
