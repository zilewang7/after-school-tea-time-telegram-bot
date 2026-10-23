/**
 * The media working set of one reply: what search_images found, what
 * fetch_image pulled into the model's context, and the one-image-per-reply flag.
 *
 * There are no quotas here on purpose. Searching, paging and reading are the
 * model's call — the only real bound is the tool-round budget it is told about
 * in every tool result. What is pinned is behaviour, not allowance: ids are
 * stable per reply (`q1` a search, `s1…` a candidate, `img1…` an image the
 * model has actually read) and paging never repeats a picture.
 *
 * Thumbnail windows are deliberately lopsided: only the reply's first search
 * shows three pictures, every later search shows whatever is still unseen.
 * Round trips cost more than image tokens here (see the design doc).
 */
import type { SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { SendKind } from '../../services/image-search-service.js';

/** Thumbnails in the reply's very first window */
export const FIRST_THUMBNAIL_WINDOW = 3;
/** Candidates one search keeps */
export const MAX_SEARCH_CANDIDATES = 8;

export interface SearchCandidate {
    /** `s1`, `s2`, … across every search of this reply */
    readonly id: string;
    readonly searchId: string;
    readonly title: string;
    /** The page the image was found on */
    readonly sourcePage: string;
    readonly domain: string;
    readonly imageUrl: string;
    readonly thumbnailUrl: string;
    readonly width?: number;
    readonly height?: number;
    readonly format?: string;
    /** static: sendable as a photo; animated: a GIF; unsupported: only the thumbnail */
    readonly sendKind: SendKind;
}

export interface SearchSet {
    /** `q1`, `q2`, … */
    readonly id: string;
    /** Normalized query, as the cache and the model see it */
    readonly query: string;
    readonly candidates: readonly SearchCandidate[];
    /** Candidate ids already attached for the model to look at */
    readonly viewedIds: Set<string>;
}

export interface FetchedImage {
    /** `img1`, … */
    readonly id: string;
    /** Bytes to deliver: the GIF original, or the static picture */
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
    /** The frame the model reads and generate_image may reference */
    readonly still: {
        readonly data: Buffer;
        readonly mimeType: SniffedMediaMime;
    };
    readonly sourcePage: string;
    readonly title?: string;
    readonly imageUrl: string;
    /** The candidate this came from, when it did */
    readonly candidateId?: string;
}

export interface ReplyMediaState {
    readonly searches: Map<string, SearchSet>;
    readonly candidates: Map<string, SearchCandidate>;
    readonly fetched: Map<string, FetchedImage>;
    /** Image URLs the trigger message contained; url arguments must be in here */
    readonly allowedUrls: Set<string>;
    /** Thumbnails attached so far; only the first window of the reply is small */
    thumbnailCount: number;
    /** Set by the first image this reply will deliver */
    hasReplyImage: boolean;
}

const urlPattern = /https?:\/\/[^\s<>"'）)】\]]+/g;

/** The trigger message's own image links, normalized */
const urlsOf = (text: string | null): string[] => {
    if (!text) return [];
    return (text.match(urlPattern) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ''));
};

export const createReplyMediaState = (triggerText: string | null): ReplyMediaState => ({
    searches: new Map(),
    candidates: new Map(),
    fetched: new Map(),
    allowedUrls: new Set(urlsOf(triggerText)),
    thumbnailCount: 0,
    hasReplyImage: false,
});

/** `q1`, `q2`, …: one per search this reply makes */
export const nextSearchId = (state: ReplyMediaState): string => `q${state.searches.size + 1}`;

/** `s1`, `s2`, …: continuous across searches, so `s9` needs no query to read */
export const allocateCandidateIds = (state: ReplyMediaState, count: number): string[] => {
    const first = state.candidates.size + 1;
    return Array.from({ length: count }, (_, index) => `s${first + index}`);
};

export const nextFetchedImageId = (state: ReplyMediaState): string => `img${state.fetched.size + 1}`;

export const addAllowedUrls = (state: ReplyMediaState, urls: readonly string[]): void => {
    for (const url of urls) state.allowedUrls.add(url);
};

/** The candidates of a set that were never attached for the model to look at */
export const unseenCandidates = (set: SearchSet): SearchCandidate[] =>
    set.candidates.filter((candidate) => !set.viewedIds.has(candidate.id));

/**
 * How many thumbnails this call shows: the first search of the reply shows
 * three, later calls show everything unseen in that set.
 */
export const thumbnailWindowSize = (state: ReplyMediaState, set: SearchSet): number => {
    const unseen = unseenCandidates(set).length;
    return state.thumbnailCount === 0 ? Math.min(FIRST_THUMBNAIL_WINDOW, unseen) : unseen;
};
