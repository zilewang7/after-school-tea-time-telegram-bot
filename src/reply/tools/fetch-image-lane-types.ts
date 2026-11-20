/**
 * What one fetch_image source yields, in the shape both read paths use: the
 * single read gives it an id and materializes the tuned text, a batch collects
 * the same data for several sources and writes one compact answer.
 *
 * A lane decides what only it knows — which bytes, where they came from, which
 * state field they register in, what the single-result text says — so the tool
 * and the batch never re-derive a lane's rules.
 */
import type { GroundingCitation } from '../../ai/types.js';
import type { SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { ImageDownloadDependencies } from './image-source-download.js';

export interface FetchImageDependencies extends ImageDownloadDependencies {
    /** Null/absent: no converter, the model gets the still frame */
    readonly transcodeAnimation?: (gif: Buffer) => Promise<Buffer | null>;
}

/** What the model reads back for one picture, once its id is known */
export interface LaneMaterialized {
    /** The single-source result text (what fetch_image says after reading one) */
    readonly content: string;
    /** Caption of the bytes when they are replayed to the model */
    readonly caption: string;
    /** The Tools block's per-call summary of this read, e.g. `img1 640×480` */
    readonly traceResult: string;
}

export interface LaneRead {
    /** `img` for pictures, `st` for sticker previews: the id namespace it takes */
    readonly kind: 'image' | 'sticker';
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime | 'video/mp4';
    /** Writes the bytes into the reply's media state under the given id */
    readonly register: (id: string) => void;
    readonly materialize: (id: string) => LaneMaterialized;
    /** One compact line for a batch result: `候选 s1「标题」，640x480，image/jpeg，120KB` */
    readonly summary: string;
    /** The page a batch lists under 来源页, when the lane has one */
    readonly sourcePage: string | null;
    /** Citation for the merged Sources block */
    readonly citation?: GroundingCitation;
    readonly searchQuery?: string;
}

export type LaneOutcome =
    | { readonly ok: true; readonly status: 'read'; readonly read: LaneRead }
    | {
          readonly ok: true;
          readonly status: 'reuse';
          /** The id the picture already has in this reply */
          readonly id: string;
          /** The single-source text saying it is already there */
          readonly content: string;
          readonly traceResult: string;
      }
    | { readonly ok: false; readonly error: string };

/** `kb` as the model sees it elsewhere (`120KB`), not the log's `120KB`/`1.2MB` */
export const kilobytesOf = (bytes: number): string => `${Math.round(bytes / 1024)}KB`;

/** `640x480，` when both sides are known, else '' */
export const dimensionsOf = (width: number | null | undefined, height: number | null | undefined): string =>
    width !== null && width !== undefined && height !== null && height !== undefined ? `${width}x${height}，` : '';

/**
 * One batch result line's source part: the label plus what the picture is,
 * so the model can tell six reads apart without opening the individual results.
 */
export const laneSummaryOf = (input: {
    readonly label: string;
    readonly mimeType: string;
    readonly dataLength: number;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly note?: string | null;
}): string => {
    const note = input.note === null || input.note === undefined || input.note === '' ? '' : `，${input.note}`;
    return `${input.label}，${dimensionsOf(input.width, input.height)}${input.mimeType}，${kilobytesOf(input.dataLength)}${note}`;
};

/** Cut by code points without splitting an emoji */
export const excerptOf = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
};

/**
 * A title from an untrusted page, on one line: a newline in it would forge
 * another item in the batch result's list.
 */
export const shortTitleOf = (title: string, maxChars = 40): string =>
    excerptOf(title.replace(/\s+/g, ' ').trim(), maxChars);
