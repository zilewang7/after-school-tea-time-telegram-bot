/**
 * The media working set of one reply: what search_images found, what
 * fetch_image pulled into the model's context, what generate_image drew, and
 * the one-attachment-per-reply flag.
 *
 * There are no quotas here on purpose. Searching, paging and reading are the
 * model's call — the only real bound is the tool-round budget it is told about
 * in every tool result. What is pinned is behaviour, not allowance: ids are
 * stable per reply (`q1` a search, `s1…` a candidate, `img1…` an image the
 * model has actually read, `g1…` a picture it drew) and paging never repeats a
 * picture.
 *
 * Drawing is the one exception: a picture is a model call of its own, so a
 * reply may draw at most MAX_GENERATED_IMAGES of them (see the design doc
 * 2026-1104-1820). A failed draw does not use one up.
 *
 * Thumbnail windows are deliberately lopsided: only the reply's first search
 * shows three pictures, every later search shows whatever is still unseen.
 * Round trips cost more than image tokens here (see the design doc).
 */
import type { SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { FileDelivery, WidgetDelivery } from '../../ai/types.js';
import type { SendKind } from '../../services/image-search-service.js';

/** Thumbnails in the reply's very first window */
export const FIRST_THUMBNAIL_WINDOW = 3;
/** Candidates one search keeps */
export const MAX_SEARCH_CANDIDATES = 8;
/**
 * Pictures one reply may draw. Each one is a model call of 10-20s, and the
 * model is expected to compare them and send the best, so the cap is about
 * wall clock, not tokens.
 */
export const MAX_GENERATED_IMAGES = 5;

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

/**
 * A picture generate_image drew in this reply. It is not delivered on its own:
 * the model looks at it, may keep editing it, and send_image posts the one it
 * picks.
 */
export interface GeneratedImage {
    /** `g1`, … */
    readonly id: string;
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
}

/** One attachment per reply: an image, a sticker or a file */
export const ONE_ATTACHMENT_PER_REPLY =
    '这条回复已经有一个附件（图片/贴纸/文件/组件），每条回复只能发一个。';

/**
 * The file this reply is writing with send_file. Parts are appended in call
 * order; the whole text is joined once when the delivery is built.
 */
export interface ReplyFileDraft {
    /** Sanitized name; the first call fixes it */
    readonly name: string;
    readonly mimeType: string;
    readonly parts: string[];
    /** First non-empty caption wins */
    caption?: string;
    /** The parts are a workspace file's complete content, so appending would contradict it */
    readonly fromWorkspace?: boolean;
}

export interface ReplyMediaState {
    readonly searches: Map<string, SearchSet>;
    readonly candidates: Map<string, SearchCandidate>;
    readonly fetched: Map<string, FetchedImage>;
    /** `g1`, …: pictures this reply has drawn and not sent yet */
    readonly generated: Map<string, GeneratedImage>;
    /** `st1`, … → pack index of a sticker the model has previewed */
    readonly fetchedStickers: Map<string, number>;
    /** `target+view` → `imgN`: the same avatar is only resolved and downloaded once */
    readonly readAvatars: Map<string, string>;
    /** Thumbnails attached so far; only the first window of the reply is small */
    thumbnailCount: number;
    /**
     * Real (non-cached) search_by_image calls so far. Kept here, not in the
     * tool, so a continued reply goes on counting toward the same limit.
     */
    reverseSearchCount: number;
    /** Set by the image this reply will deliver */
    hasReplyImage: boolean;
    /** Set by the sticker this reply will deliver */
    hasReplySticker: boolean;
    /** The file this reply is writing; absent until send_file is called */
    fileDraft?: ReplyFileDraft;
    /** Set by the file this reply will deliver */
    hasReplyFile: boolean;
    /** The chat UI card this reply will deliver; absent until send_widget is called */
    widget?: WidgetDelivery;
    /** Set by the widget this reply will deliver */
    hasReplyWidget: boolean;
}

export const createReplyMediaState = (): ReplyMediaState => ({
    searches: new Map(),
    candidates: new Map(),
    fetched: new Map(),
    generated: new Map(),
    fetchedStickers: new Map(),
    readAvatars: new Map(),
    thumbnailCount: 0,
    reverseSearchCount: 0,
    hasReplyImage: false,
    hasReplySticker: false,
    hasReplyFile: false,
    hasReplyWidget: false,
});

/** UTF-8 size of everything written into the draft so far */
export const fileDraftBytes = (draft: ReplyFileDraft): number =>
    Buffer.byteLength(draft.parts.join(''), 'utf8');

/** The draft as the delivery layer, the stored version and the next context read it */
export const fileDeliveryOf = (draft: ReplyFileDraft): FileDelivery => ({
    name: draft.name,
    mimeType: draft.mimeType,
    data: Buffer.from(draft.parts.join(''), 'utf8'),
    ...(draft.caption ? { caption: draft.caption } : {}),
});

/** `q1`, `q2`, …: one per search this reply makes */
export const nextSearchId = (state: ReplyMediaState): string => `q${state.searches.size + 1}`;

/** `s1`, `s2`, …: continuous across searches, so `s9` needs no query to read */
export const allocateCandidateIds = (state: ReplyMediaState, count: number): string[] => {
    const first = state.candidates.size + 1;
    return Array.from({ length: count }, (_, index) => `s${first + index}`);
};

export const nextFetchedImageId = (state: ReplyMediaState): string => `img${state.fetched.size + 1}`;

/** `g1`, `g2`, …: only successful draws take a number */
export const nextGeneratedImageId = (state: ReplyMediaState): string => `g${state.generated.size + 1}`;

/** The ids of the pictures drawn so far, as the model reads them: `g1 g2` */
export const generatedImageIds = (state: ReplyMediaState): string[] => [...state.generated.keys()];

export const nextFetchedStickerId = (state: ReplyMediaState): string => `st${state.fetchedStickers.size + 1}`;

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
