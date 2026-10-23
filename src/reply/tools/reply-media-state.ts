/**
 * The media working set of one reply: what search_images found, what
 * fetch_image pulled into the model's context, and the budgets that keep a
 * single reply from spiralling.
 *
 * Ids are per reply and stable: `q1` is a search, `s1…` a candidate (numbered
 * across searches), `img1…` an image the model has actually read. The model is
 * told these ids and may use them in later calls, so nothing here is reused.
 *
 * Thumbnail budget is deliberately lopsided: only the reply's first search
 * shows three pictures, every later search shows whatever is still unseen.
 * Round trips cost more than image tokens here (see the design doc).
 */
import type { SniffedImageMime } from '../../ai/image-generation/image-mime.js';

/**
 * Searches a reply may run (each one hits SearXNG). Two is deliberate: the
 * tool rounds are finite, and a reply that spends them all searching can no
 * longer send the picture it found (live, 2026-10-23).
 */
export const MAX_IMAGE_SEARCHES = 2;
/** Paging / details calls a reply may make (no network) */
export const MAX_SEARCH_PAGES = 4;
/** Safety net across all searches: two full batches (3 + 5 + 8) */
export const MAX_SEARCH_THUMBNAILS = 16;
/** fetch_image calls per reply; re-reading the same image is free */
export const MAX_IMAGE_FETCHES = 4;
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
    /** False for GIF/SVG/unknown originals: only the thumbnail can be sent */
    readonly originalSendable: boolean;
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
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
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
    searchCount: number;
    searchPageCount: number;
    thumbnailCount: number;
    fetchCount: number;
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
    searchCount: 0,
    searchPageCount: 0,
    thumbnailCount: 0,
    fetchCount: 0,
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

/** Whether the reply has room for one more fetch */
export const canFetchImage = (state: ReplyMediaState): boolean => state.fetchCount < MAX_IMAGE_FETCHES;
