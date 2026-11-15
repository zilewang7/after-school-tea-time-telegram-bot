/**
 * The inline picture markers of an answer: hiding them from everything the user
 * sees, and assembling the rich body that will embed them.
 *
 * The model writes a picture as a markdown image on a paragraph of its own
 * (`![图注](g1)`, the ref one of the `send_image` ids or a public URL). Only
 * that shape becomes an inline picture; every other use of the syntax is
 * cleaned to the alt text, because a rich message accepts a media block only as
 * a block of its own and an internal id (`g1`) would be refused as a URL.
 *
 * Two derived texts come out of one scan:
 * - `cleanText`: no marker left. This is what is displayed, stored and shown by
 *   the entities fallback (a demoted reply must not leak `![…](g1)`).
 * - `assemblyText`: each embedded marker is its own `⟦media:imgK⟧` paragraph.
 *   Then `withCitations` and `toRichMarkdown` see ordinary text, and the
 *   sentinels become the media blocks afterwards.
 *
 * The scan is driven by telegram-md-entities' `collectRichImages` (see
 * collect.ts), so its block rule is the package's: a root-level paragraph whose
 * only content is the image. Markers inside a quote, a list, a table, a heading,
 * a code block or inline code are cleaned as text, never embedded.
 */
import { collectRichImages } from './collect.js';
import { mediaSentinelOf } from './media-blocks.js';

/** One picture the body embeds: what to resolve, and the id the body uses */
export interface InlineMediaPlacement {
    /** The media id the body references: `img1`, `img2`, … */
    readonly mediaId: string;
    /** The ref as the model wrote it: `g1`, `img2`, `s3`, `#12:2`, `https://…` */
    readonly ref: string;
    /** The caption source: the syntax's title if it has one, else its alt text */
    readonly caption: string;
}

export interface InlineScanOptions {
    /**
     * The reply embeds pictures. Off (a reply whose rich delivery cannot take
     * media) still hides internal refs — Telegram would refuse them — while a
     * public picture URL keeps today's behaviour of rendering as it is.
     */
    readonly embed: boolean;
}

export interface InlineScanResult {
    /** Display, storage and the entities fallback: no marker syntax left */
    readonly cleanText: string;
    /** The rich body source: each embedded picture is a sentinel paragraph */
    readonly assemblyText: string;
    /** One entry per distinct ref, in the order they first appear */
    readonly placements: readonly InlineMediaPlacement[];
}

/** The id forms the model can name: a drawn picture, a read one, a candidate, a context picture */
const INTERNAL_REF = /^(?:g\d+|img\d+|s\d+|#\d{1,3}(?::\d+)?)$/;

/** A ref this bot can resolve at all (what `parseMediaRef` accepts, as a shape) */
const KNOWN_REF = /^(?:g\d+|img\d+|s\d+|#\d{1,3}(?::\d+)?|https?:\/\/\S+)$/;

/** A fence opening: up to three spaces, then three or more backticks or tildes */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A picture the model was still writing when the answer stopped: no closing paren */
const PARTIAL_IMAGE = /!\[[^\]]*\]?\(?[^)\n]*$/;

/** A picture syntax whose reference-style label has no definition */
const UNDEFINED_REFERENCE_IMAGE = /!\[([^\]]*)\]\[[^\]]*\]/g;

interface PictureEdit {
    /** Offset of the image's first character in the source */
    readonly start: number;
    /** Offset just past its last character */
    readonly end: number;
    /** What the clean text keeps there */
    readonly clean: string;
    /** What the assembly text keeps there */
    readonly assembly: string;
    /** Set when the body embeds this picture: its media id */
    readonly mediaId?: string;
    /** Set when the body embeds this picture */
    readonly ref?: string;
    /** Set when the body embeds this picture: the caption source */
    readonly caption?: string;
}

/** The caption of one picture: the title when the syntax has one, else the alt text */
const captionOf = (alt: string, title: string | undefined): string => (title === undefined ? alt : title);

/** Append a placement, reusing the id and caption of the same ref */
const placementFor = (
    placements: Map<string, InlineMediaPlacement>,
    ref: string,
    caption: string
): InlineMediaPlacement => {
    const known = placements.get(ref);
    if (known !== undefined) return known;
    const placement: InlineMediaPlacement = { mediaId: `img${placements.size + 1}`, ref, caption };
    placements.set(ref, placement);
    return placement;
};

/** The edits one scan makes, and the placements it collects, in source order */
const planScan = (
    text: string,
    options: InlineScanOptions
): { readonly edits: readonly PictureEdit[]; readonly placements: readonly InlineMediaPlacement[] } => {
    const images = collectRichImages(text);
    const edits: PictureEdit[] = [];
    const placements = new Map<string, InlineMediaPlacement>();

    for (const image of images) {
        const ref = image.url.trim();
        // The model's own caption (title first); empty means a bare picture
        const caption = captionOf(image.alt, image.title).trim();
        const embeddable = image.block && KNOWN_REF.test(ref);
        if (embeddable && options.embed) {
            const placement = placementFor(placements, ref, caption);
            edits.push({
                start: image.start,
                end: image.end,
                clean: '',
                assembly: mediaSentinelOf(placement.mediaId),
                mediaId: placement.mediaId,
                ref,
                caption,
            });
            continue;
        }
        if (image.block && INTERNAL_REF.test(ref)) {
            // Not embeddable, but an internal id would be refused: hide the marker
            edits.push({ start: image.start, end: image.end, clean: '', assembly: '' });
            continue;
        }
        if (!options.embed && /^https?:\/\//.test(ref)) {
            // Today's behaviour: a public picture URL is left for the rich
            // renderer to pass through (or the entities path to linkify)
            continue;
        }
        // Every other use of image syntax becomes its alt text: a rich message
        // cannot show it inline, and the raw syntax would reach the reader
        edits.push({
            start: image.start,
            end: image.end,
            clean: image.alt.trim(),
            assembly: image.alt.trim(),
        });
    }

    return { edits, placements: [...placements.values()] };
};

/** An open fenced code block: its marker character and length */
interface FenceState {
    readonly char: string;
    readonly length: number;
}

/** Whether a line is inside a fenced code block as of its predecessor state */
const opensFence = (line: string): FenceState | null => {
    const matched = FENCE.exec(line);
    if (matched === null) return null;
    return { char: matched[1]?.[0] ?? '`', length: matched[1]?.length ?? 3 };
};

const closesFence = (line: string, open: FenceState): boolean => {
    const matched = FENCE.exec(line);
    return (
        matched !== null &&
        matched[1]?.[0] === open.char &&
        (matched[1]?.length ?? 0) >= open.length &&
        (matched[2] ?? '').trim() === ''
    );
};

/**
 * Hide what is left of a picture the model was still writing (a stopped or cut
 * answer ends inside `![…](g`), and clean a reference-style use whose definition
 * the document never had. Code blocks are left alone: there the syntax is the
 * text the answer is showing.
 */
const cleanLeftovers = (text: string): string => {
    const lines = text.split('\n');
    let fence: FenceState | null = null;
    const cleaned = lines.map((line) => {
        if (fence !== null) {
            if (closesFence(line, fence)) fence = null;
            return line;
        }
        const opening = opensFence(line);
        if (opening !== null) {
            fence = opening;
            return line;
        }
        if (!line.includes('![')) return line;
        const withoutReferences = line.replace(UNDEFINED_REFERENCE_IMAGE, (_whole, alt: string) => alt);
        const withoutPartial = withoutReferences.replace(PARTIAL_IMAGE, '');
        return withoutPartial === withoutReferences ? withoutReferences : withoutPartial.trimEnd();
    });
    return cleaned.join('\n');
};

/**
 * Merge the blank lines a removed marker left, and trim the document's edges.
 * Fenced code keeps its bytes: a code block is the answer's text, so the fold
 * and the edge trim apply to the text outside the fences only.
 */
const normalizeBlocks = (text: string): string => {
    /** One source line, and whether a fenced code block owns it verbatim */
    interface SourceLine {
        readonly text: string;
        readonly inFence: boolean;
    }
    const lines: SourceLine[] = [];
    let fence: FenceState | null = null;
    for (const line of text.split('\n')) {
        if (fence !== null) {
            lines.push({ text: line, inFence: true });
            if (closesFence(line, fence)) fence = null;
            continue;
        }
        const opening = opensFence(line);
        if (opening !== null) {
            lines.push({ text: line, inFence: true });
            fence = opening;
            continue;
        }
        lines.push({ text: line.trim() === '' ? '' : line, inFence: false });
    }

    // Trim the document's edges: a fence line is content, never an edge
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start]?.inFence === false && lines[start]?.text === '') start += 1;
    while (end > start && lines[end - 1]?.inFence === false && lines[end - 1]?.text === '') end -= 1;

    // Fold a run of blank lines outside the fences to one blank line
    const normalized: string[] = [];
    let blank = false;
    for (let index = start; index < end; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (line.inFence) {
            normalized.push(line.text);
            blank = false;
            continue;
        }
        if (line.text === '') {
            if (!blank) normalized.push('');
            blank = true;
            continue;
        }
        normalized.push(line.text);
        blank = false;
    }
    return normalized.join('\n');
};

/** Apply edits to one source, as one of the two derived texts */
const applyEdits = (
    text: string,
    edits: readonly PictureEdit[],
    pick: (edit: PictureEdit) => string
): string => {
    if (edits.length === 0) return text;
    let result = '';
    let cursor = 0;
    for (const edit of edits) {
        if (edit.start < cursor) continue;
        result += text.slice(cursor, edit.start);
        result += pick(edit);
        cursor = edit.end;
    }
    return result + text.slice(cursor);
};

interface ScannedTexts {
    readonly cleanText: string;
    readonly assemblyText: string;
    readonly placements: readonly InlineMediaPlacement[];
}

/** Run one scan on the raw answer, for the final delivery and for the display hooks */
const scan = (text: string, options: InlineScanOptions): ScannedTexts => {
    if (!text.includes('![')) return { cleanText: text, assemblyText: text, placements: [] };
    const { edits, placements } = planScan(text, options);
    // A text whose only image syntax is safe (a public URL kept as it is, or a
    // code example) must come back byte for byte
    const withoutLeftovers = cleanLeftovers(text);
    if (edits.length === 0 && withoutLeftovers === text) {
        return { cleanText: text, assemblyText: text, placements: [] };
    }
    const clean = normalizeBlocks(cleanLeftovers(applyEdits(text, edits, (edit) => edit.clean)));
    const assembly = normalizeBlocks(cleanLeftovers(applyEdits(text, edits, (edit) => edit.assembly)));
    return { cleanText: clean, assemblyText: assembly, placements };
};

/**
 * The final delivery's scan: the clean text for everything the reply shows and
 * stores, the assembly text for the rich body, and the pictures to resolve.
 */
export const scanInlineMarkers = (text: string, options: InlineScanOptions): InlineScanResult => scan(text, options);

/**
 * The display hook (a streaming rich frame, an entities frame after a demotion,
 * an error display, the text persisted before an error): the same cleaning, the
 * clean text only. A text without image syntax is returned unchanged.
 */
export const stripInlineMarkersForDisplay = (text: string, options: InlineScanOptions): string =>
    scan(text, options).cleanText;
