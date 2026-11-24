/**
 * The shapes shared by the reverse-search engines and by the tool text.
 *
 * One search_by_image call can run several engines; every site keeps the
 * engine that found it, and `match` says how sure that engine is that the page
 * holds the very same picture: SauceNAO scores a similarity, Yandex only says
 * "this page contains the picture" (verified against the other sizes), and
 * trace.moe matches one frame of an anime.
 */

/** The engines search_by_image knows how to ask */
export type ReverseSearchEngineId = 'yandex' | 'saucenao' | 'tracemoe';

/** The engines a call can name; auto is Yandex plus a SauceNAO supplement */
export type ReverseSearchEngineChoice = 'auto' | ReverseSearchEngineId;

/** The choices a tool call may pass, in the order the error message lists them */
export const REVERSE_SEARCH_ENGINE_CHOICES: readonly ReverseSearchEngineChoice[] = [
    'auto',
    'yandex',
    'saucenao',
    'tracemoe',
];

/** exact = the same picture; likely = a close match; unverified = no same-image evidence */
export type ReverseSearchMatchKind = 'exact' | 'likely' | 'unverified';

export interface ReverseSearchSite {
    readonly engine: ReverseSearchEngineId;
    readonly match: ReverseSearchMatchKind;
    readonly title: string;
    readonly url: string;
    readonly domain: string;
    readonly description: string;
    /** 0–100 for the engines that score a match (SauceNAO, trace.moe) */
    readonly similarity?: number;
    /** Yandex: the picture that page holds; other engines: a preview when given */
    readonly imageUrl?: string;
    readonly width?: number;
    readonly height?: number;
}

export interface ReverseSearchSize {
    readonly url: string;
    readonly width: number;
    readonly height: number;
}

export interface ReverseSearchSimilar {
    readonly title: string;
    readonly imageUrl: string;
}

/** What one engine found, before any merging */
export interface ParsedReverseSearch {
    readonly sites: readonly ReverseSearchSite[];
    readonly sizes: readonly ReverseSearchSize[];
    readonly similar: readonly ReverseSearchSimilar[];
    readonly tags: readonly string[];
}

/** Why one engine did not deliver what was asked of it */
export type ReverseSearchErrorKind =
    | 'too-large'
    | 'timeout'
    | 'aborted'
    | 'blocked'
    | 'parse'
    | 'network'
    | 'rate-limited'
    | 'unconfigured';

export interface ReverseSearchEngineRun {
    readonly engine: ReverseSearchEngineId;
    readonly status: 'ok' | 'failed';
    /** true when this run answered from the per-engine cache */
    readonly cached: boolean;
    readonly elapsedMs: number;
    /** status failed only */
    readonly kind?: ReverseSearchErrorKind;
    readonly error?: string;
}

/** Everything one search_by_image call returns: the merged lists and the per-engine runs */
export interface ReverseSearchResult extends ParsedReverseSearch {
    readonly engines: readonly ReverseSearchEngineRun[];
}
