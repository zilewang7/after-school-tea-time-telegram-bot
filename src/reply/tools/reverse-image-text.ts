/**
 * What search_by_image tells the model. Pure text, no instruction: the tool
 * reports what Yandex returned and which `sN` id points at which picture; what
 * the model does with that is its call.
 */
import type { ParsedReverseSearch, ReverseSearchSite } from '../../services/image-reverse-search-parse.js';
import type { SearchCandidate } from './reply-media-state.js';

const MAX_SITES = 6;
const MAX_TAGS = 5;

export interface ReverseSearchTextInput {
    readonly result: ParsedReverseSearch;
    readonly sizes: readonly SearchCandidate[];
    readonly similar: readonly SearchCandidate[];
    readonly cached: boolean;
    readonly elapsedMs: number;
}

const seconds = (milliseconds: number): string => (milliseconds / 1000).toFixed(1);

const headerOf = (input: ReverseSearchTextInput): string => {
    const elapsed = input.cached ? '缓存' : `${seconds(input.elapsedMs)}s`;
    const { sites, sizes, similar } = input.result;
    return (
        `以图搜图（Yandex，${elapsed}）：来源页 ${sites.length} 条，` +
        `其他尺寸 ${sizes.length} 条，相似图 ${similar.length} 条`
    );
};

const siteLine = (site: ReverseSearchSite, index: number): string =>
    `${index + 1}. ${site.title} — ${site.domain} — ${site.url}`;

const siteLines = (sites: readonly ReverseSearchSite[]): string[] => {
    if (sites.length === 0) return [];
    return [
        '',
        '来源页（Yandex 认为包含这张图的网页）：',
        ...sites.slice(0, MAX_SITES).map(siteLine),
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

export const formatReverseSearchResult = (input: ReverseSearchTextInput): string => {
    const { result } = input;
    const lines: string[] = [headerOf(input)];

    if (result.sites.length === 0 && result.sizes.length === 0 && result.similar.length === 0) {
        lines.push('', '没有找到来源页、其他尺寸或相似图。');
    } else {
        lines.push(...siteLines(result.sites));
        lines.push(...sizeLines(input.sizes));
        lines.push(...similarLines(input.similar));
    }
    lines.push(...tagLines(result.tags));
    return lines.join('\n');
};
