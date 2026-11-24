/**
 * What search_by_image tells the model. Pure text, no instruction: the tool
 * reports which engine answered what, how sure it is and which `sN` id points
 * at which picture; what the model does with that is its call.
 *
 * The sections keep the engines apart on purpose: "精确来源" is a gallery entry
 * with a similarity (SauceNAO) or an anime frame (trace.moe), while a "来源页"
 * is only a page Yandex believes contains the picture — marked `[同图]` when
 * Yandex's own other-sizes list backs that up, `[未验证]` otherwise.
 */
import {
    SAUCENAO_EXACT_SIMILARITY,
    SAUCENAO_LIKELY_SIMILARITY,
} from '../../services/image-reverse-search-saucenao.js';
import type {
    ReverseSearchEngineId,
    ReverseSearchEngineRun,
    ReverseSearchErrorKind,
    ReverseSearchResult,
    ReverseSearchSite,
} from '../../services/image-reverse-search-types.js';
import type { SearchCandidate } from './reply-media-state.js';

const MAX_SITES = 6;
const MAX_TAGS = 5;

const ENGINE_LABELS: Readonly<Record<ReverseSearchEngineRun['engine'], string>> = {
    yandex: 'Yandex',
    saucenao: 'SauceNAO',
    tracemoe: 'trace.moe',
};

const KIND_TEXT: Readonly<Record<ReverseSearchErrorKind, string>> = {
    'too-large': '图片过大',
    timeout: '超时',
    aborted: '已取消',
    blocked: '被站点拦截',
    parse: '解析失败',
    network: '网络错误',
    'rate-limited': '限流或冷却中',
    unconfigured: '未配置 API key',
};

export interface ReverseSearchTextInput {
    readonly result: ReverseSearchResult;
    readonly sizes: readonly SearchCandidate[];
    readonly similar: readonly SearchCandidate[];
    readonly cached: boolean;
    /** The call asked SauceNAO for Known Safe results only */
    readonly safe: boolean;
}

const seconds = (milliseconds: number): string => (milliseconds / 1000).toFixed(1);

const percent = (value: number): string => (Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`);

const sitesOf = (result: ReverseSearchResult, engine: ReverseSearchEngineId): ReverseSearchSite[] =>
    result.sites.filter((site) => site.engine === engine);

const timingOf = (runs: readonly ReverseSearchEngineRun[], cached: boolean): string => {
    const parts = runs
        .filter((run) => run.status === 'ok')
        .map((run) =>
            cached || run.cached
                ? `${ENGINE_LABELS[run.engine]} 缓存`
                : `${ENGINE_LABELS[run.engine]} ${seconds(run.elapsedMs)}s`
        );
    return parts.length === 0 ? '缓存' : parts.join(' + ');
};

const headerOf = (input: ReverseSearchTextInput): string => {
    const { result } = input;
    const yandexSites = sitesOf(result, 'yandex');
    const exact = sitesOf(result, 'saucenao').filter((site) => site.match === 'exact');
    const likely = sitesOf(result, 'saucenao').filter((site) => site.match === 'likely');
    const traced = sitesOf(result, 'tracemoe');
    const sameImage = yandexSites.filter((site) => site.match === 'exact').length;

    const counts: string[] = [];
    if (exact.length > 0) counts.push(`精确来源 ${exact.length} 条`);
    if (likely.length > 0) counts.push(`可能来源 ${likely.length} 条`);
    if (traced.length > 0) counts.push(`动画出处 ${traced.length} 条`);
    if (result.engines.some((run) => run.engine === 'yandex') || yandexSites.length > 0) {
        const mark = sameImage > 0 ? `（同图 ${sameImage}）` : '';
        counts.push(`来源页 ${yandexSites.length} 条${mark}`);
    }
    if (result.engines.some((run) => run.engine === 'yandex') || result.sizes.length > 0) {
        counts.push(`其他尺寸 ${result.sizes.length} 条`);
    }
    if (result.engines.some((run) => run.engine === 'yandex') || result.similar.length > 0) {
        counts.push(`相似图 ${result.similar.length} 条`);
    }

    const header = `以图搜图（${timingOf(result.engines, input.cached)}）`;
    return counts.length === 0 ? header : `${header}：${counts.join('，')}`;
};

const exactLines = (exact: readonly ReverseSearchSite[]): string[] => {
    if (exact.length === 0) return [];
    return [
        '',
        `精确来源（SauceNAO，相似度 ≥${SAUCENAO_EXACT_SIMILARITY}%）：`,
        ...exact
            .slice(0, MAX_SITES)
            .map(
                (site, index) =>
                    `${index + 1}. ${percent(site.similarity ?? 0)} — ${site.title} — ${site.domain} — ${site.url}`
            ),
    ];
};

const likelyLines = (likely: readonly ReverseSearchSite[]): string[] => {
    if (likely.length === 0) return [];
    const upper = SAUCENAO_EXACT_SIMILARITY - 1;
    return [
        '',
        `可能来源（SauceNAO，相似度 ${SAUCENAO_LIKELY_SIMILARITY}–${upper}%）：`,
        ...likely
            .slice(0, MAX_SITES)
            .map(
                (site, index) =>
                    `${index + 1}. ${percent(site.similarity ?? 0)} — ${site.title} — ${site.domain} — ${site.url}`
            ),
    ];
};

const traceLines = (traced: readonly ReverseSearchSite[]): string[] => {
    if (traced.length === 0) return [];
    return [
        '',
        '动画出处（trace.moe，按相似度）：',
        ...traced.slice(0, MAX_SITES).map((site, index) => {
            const details = site.description === '' ? '' : ` — ${site.description}`;
            return `${index + 1}. ${percent(site.similarity ?? 0)} — ${site.title}${details} — ${site.url}`;
        }),
    ];
};

const matchMark = (site: ReverseSearchSite): string => (site.match === 'exact' ? '[同图]' : '[未验证]');

const siteLines = (sites: readonly ReverseSearchSite[]): string[] => {
    if (sites.length === 0) return [];
    return [
        '',
        '来源页（Yandex 认为包含这张图的网页，[同图] 表示其他尺寸里有同一张图）：',
        ...sites
            .slice(0, MAX_SITES)
            .map((site, index) => `${index + 1}. ${matchMark(site)} ${site.title} — ${site.domain} — ${site.url}`),
    ];
};

const sizeLine = (candidate: SearchCandidate): string => {
    const dimension =
        candidate.width !== undefined && candidate.height !== undefined
            ? `${candidate.width}×${candidate.height}`
            : '尺寸未知';
    return `- ${dimension} — ${candidate.id} — ${candidate.imageUrl}`;
};

const sizeLines = (sizes: readonly SearchCandidate[]): string[] => {
    if (sizes.length === 0) return [];
    return ['', `其他尺寸（列出最大的 ${sizes.length} 条）：`, ...sizes.map(sizeLine)];
};

const similarLine = (candidate: SearchCandidate): string =>
    `- ${candidate.title} — ${candidate.id} — ${candidate.imageUrl}`;

const similarLines = (similar: readonly SearchCandidate[]): string[] => {
    if (similar.length === 0) return [];
    return ['', `相似图（列出 ${similar.length} 条）：`, ...similar.map(similarLine)];
};

const tagLines = (tags: readonly string[]): string[] =>
    tags.length === 0 ? [] : ['', `识别标签（Yandex，俄语）：${tags.slice(0, MAX_TAGS).join('、')}`];

/** The engine notes: what did not answer, and the safety switch when it was used */
const noteLines = (input: ReverseSearchTextInput): string[] => {
    const lines: string[] = [];
    const failed = input.result.engines.filter((run) => run.status === 'failed');
    const yandexAnswered = input.result.engines.some((run) => run.engine === 'yandex' && run.status === 'ok');
    for (const run of failed) {
        const kind = run.kind === undefined ? '未知错误' : KIND_TEXT[run.kind];
        if (run.engine === 'saucenao' && yandexAnswered) {
            lines.push(`SauceNAO 补充检索本次不可用（${kind}），以上仅为 Yandex 结果。`);
        } else if (run.engine === 'yandex') {
            lines.push(`Yandex 通用检索本次不可用（${kind}），以上仅为 SauceNAO 结果。`);
        } else {
            lines.push(`${ENGINE_LABELS[run.engine]} 本次不可用（${kind}）。`);
        }
    }
    if (input.safe) lines.push('SauceNAO 使用了安全档（hide=3，已隐藏 R-18 图库结果）。');
    return lines.length === 0 ? [] : ['', ...lines];
};

export const formatReverseSearchResult = (input: ReverseSearchTextInput): string => {
    const { result } = input;
    const exact = sitesOf(result, 'saucenao').filter((site) => site.match === 'exact');
    const likely = sitesOf(result, 'saucenao').filter((site) => site.match === 'likely');
    const traced = sitesOf(result, 'tracemoe');
    const yandexSites = sitesOf(result, 'yandex');

    const lines: string[] = [headerOf(input)];
    const empty =
        exact.length === 0 &&
        likely.length === 0 &&
        traced.length === 0 &&
        yandexSites.length === 0 &&
        input.sizes.length === 0 &&
        input.similar.length === 0;
    if (empty) {
        lines.push('', '没有找到精确来源、来源页、其他尺寸或相似图。');
    } else {
        lines.push(...exactLines(exact));
        lines.push(...likelyLines(likely));
        lines.push(...traceLines(traced));
        lines.push(...siteLines(yandexSites));
        lines.push(...sizeLines(input.sizes));
        lines.push(...similarLines(input.similar));
    }
    lines.push(...tagLines(result.tags));
    lines.push(...noteLines(input));
    return lines.join('\n');
};
