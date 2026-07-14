/**
 * Raw-text boundary splitting for the streaming continuation path: cuts RAW
 * markdown so that the rendered first part fits the message budgets, always
 * preferring paragraph/newline boundaries over proximity to the limit.
 */

export interface SplitResult {
    currentPart: string;  // Part to send now
    remaining: string;    // Part to keep in buffer
}

/** Sentence-ending characters usable as split boundaries */
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '!', '?', ';', '.']);

/** Weak boundaries: better than a mid-word cut, worse than a sentence end */
const WEAK_BOUNDARIES = new Set([' ', '，', ',', '、']);

/** Sentence/weak boundaries are only accepted in the last quarter before the limit */
const BOUNDARY_WINDOW_RATIO = 0.75;

/** Paragraph/newline boundaries are accepted anywhere past this ratio —
 *  boundary quality beats proximity: a clean line break is worth sending less */
const NEWLINE_FLOOR_RATIO = 0.25;

/**
 * Search [from, to) backwards for a paragraph break, then a newline.
 * Returns the index right after the boundary, or -1 when none exists.
 */
const findNewlineBoundaryIn = (raw: string, from: number, to: number): number => {
    const window = raw.slice(from, to);

    const paragraphBreak = window.lastIndexOf('\n\n');
    if (paragraphBreak >= 0) return from + paragraphBreak + 2;

    const newline = window.lastIndexOf('\n');
    if (newline >= 0) return from + newline + 1;

    return -1;
};

/**
 * Search [from, to) backwards for a sentence ending, then a comma/space.
 * Returns the index right after the boundary, or -1 when none exists.
 */
const findWeakerBoundaryIn = (raw: string, from: number, to: number): number => {
    for (let i = to - 1; i >= from; i--) {
        const char = raw[i];
        if (char !== undefined && SENTENCE_ENDINGS.has(char)) return i + 1;
    }

    for (let i = to - 1; i >= from; i--) {
        const char = raw[i];
        if (char !== undefined && WEAK_BOUNDARIES.has(char)) return i + 1;
    }

    return -1;
};

/**
 * Find a natural boundary in RAW (unformatted) text, searching backwards from
 * maxPos. Boundary quality beats proximity: a paragraph break / newline
 * anywhere down to 25% of maxPos wins over sentence/comma boundaries in the
 * near window [minPos, maxPos). Hard cut at maxPos only when nothing exists.
 */
const findRawBoundary = (raw: string, maxPos: number, minPos: number): number => {
    const floor = Math.floor(maxPos * NEWLINE_FLOOR_RATIO);

    const newlineCut = findNewlineBoundaryIn(raw, floor, maxPos);
    if (newlineCut >= 0) return newlineCut;

    const weakCut = findWeakerBoundaryIn(raw, minPos, maxPos);
    if (weakCut >= 0) return weakCut;

    if (floor < minPos) {
        const widened = findWeakerBoundaryIn(raw, floor, minPos);
        if (widened >= 0) return widened;
    }

    return maxPos;
};

/**
 * Cut RAW text right after its last paragraph break (falling back to the last
 * newline) at or past minPos. Used when a streaming message is being closed
 * for a continuation: the cut should land on a line boundary, not wherever
 * the last stream chunk happened to end. currentPart is empty when no
 * boundary qualifies — callers decide whether to move everything or keep all.
 */
export const splitAtLastNewline = (raw: string, minPos: number = 0): SplitResult => {
    const paragraphBreak = raw.lastIndexOf('\n\n');
    if (paragraphBreak >= minPos) {
        return {
            currentPart: raw.slice(0, paragraphBreak),
            remaining: raw.slice(paragraphBreak + 2),
        };
    }

    const newline = raw.lastIndexOf('\n');
    if (newline >= minPos) {
        return {
            currentPart: raw.slice(0, newline),
            remaining: raw.slice(newline + 1),
        };
    }

    return { currentPart: '', remaining: raw };
};

/**
 * Split RAW text so that the first part still satisfies `fits` — a predicate
 * measured on the ACTUAL rendered output (exact, no expansion-factor
 * guessing; rendering a 4k prefix is <1ms so the binary search is cheap).
 * The cut is then pulled back to a paragraph/newline/sentence boundary.
 */
export const splitRawByFits = (
    raw: string,
    fits: (prefix: string) => boolean
): SplitResult => {
    if (fits(raw)) {
        return { currentPart: raw, remaining: '' };
    }

    // Binary search the largest raw prefix that fits
    // (rendered size is monotonic in the raw prefix length)
    let low = 0;
    let high = raw.length;
    while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (fits(raw.slice(0, mid))) {
            low = mid;
        } else {
            high = mid;
        }
    }

    const cutPos = low;
    if (cutPos === 0) {
        return { currentPart: '', remaining: raw };
    }

    const minPos = Math.floor(cutPos * BOUNDARY_WINDOW_RATIO);
    let splitPos = findRawBoundary(raw, cutPos, minPos);

    // Never split inside a surrogate pair (e.g. emoji)
    const charBefore = raw.charCodeAt(splitPos - 1);
    if (charBefore >= 0xd800 && charBefore <= 0xdbff) {
        splitPos -= 1;
    }

    return {
        currentPart: raw.slice(0, splitPos),
        remaining: raw.slice(splitPos),
    };
};
