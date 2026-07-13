/**
 * Smart message splitter - finds optimal split point at newline
 */

export const TELEGRAM_MAX_LENGTH = 4000; // Safe visible limit
const TELEGRAM_RAW_HARD_LIMIT = 12000; // Safety cap for very long raw MarkdownV2 strings

export interface SplitResult {
    currentPart: string;  // Part to send now
    remaining: string;    // Part to keep in buffer
}

const findUnescapedChar = (text: string, target: string, start: number): number => {
    for (let i = start; i < text.length; i++) {
        if (text[i] === '\\') {
            i += 1;
            continue;
        }

        if (text[i] === target) {
            return i;
        }
    }

    return -1;
};

const markdownLinkAt = (
    text: string,
    start: number
): { end: number; label: string } | null => {
    if (text[start] !== '[') {
        return null;
    }

    const closeBracket = findUnescapedChar(text, ']', start + 1);
    if (closeBracket < 0 || text[closeBracket + 1] !== '(') {
        return null;
    }

    const closeParen = findUnescapedChar(text, ')', closeBracket + 2);
    if (closeParen < 0) {
        return null;
    }

    return {
        end: closeParen + 1,
        label: text.slice(start + 1, closeBracket),
    };
};

const getMarkdownUnit = (
    text: string,
    index: number
): { nextIndex: number; visibleLength: number; visibleText?: string } => {
    const current = text[index];

    if (current === '\\') {
        if (index + 1 < text.length) {
            return {
                nextIndex: index + 2,
                visibleLength: 1,
                visibleText: text[index + 1],
            };
        }

        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    if (text.startsWith('||', index)) {
        return {
            nextIndex: index + 2,
            visibleLength: 0,
        };
    }

    const markdownLink = markdownLinkAt(text, index);
    if (markdownLink) {
        return {
            nextIndex: markdownLink.end,
            visibleLength: getTelegramVisibleLength(markdownLink.label),
            visibleText: markdownLink.label,
        };
    }

    if ('*_~`'.includes(current ?? '')) {
        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    if (current === '>' && (index === 0 || text[index - 1] === '\n')) {
        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    return {
        nextIndex: index + 1,
        visibleLength: 1,
        visibleText: current,
    };
};

export const getTelegramVisibleLength = (text: string): number => {
    let index = 0;
    let visibleLength = 0;

    while (index < text.length) {
        const unit = getMarkdownUnit(text, index);
        visibleLength += unit.visibleLength;
        index = unit.nextIndex;
    }

    return visibleLength;
};

/** Sentence-ending characters usable as split boundaries */
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '!', '?', ';', '.']);

/** Sentence/weak boundaries are only accepted in the last quarter before the limit */
const BOUNDARY_WINDOW_RATIO = 0.75;

/** Paragraph/newline boundaries are accepted anywhere past this ratio —
 *  boundary quality beats proximity: a clean line break is worth sending less */
const NEWLINE_FLOOR_RATIO = 0.25;

const findSplitPos = (text: string, maxLength: number): number => {
    let index = 0;
    let visibleLength = 0;
    let lastSafeBoundary = 0;
    let paragraphPos = 0;
    let paragraphVisible = 0;
    let newlinePos = 0;
    let newlineVisible = 0;
    let sentencePos = 0;
    let sentenceVisible = 0;
    let spacePos = 0;
    let spaceVisible = 0;
    let prevVisibleChar = '';

    while (index < text.length) {
        if (index >= TELEGRAM_RAW_HARD_LIMIT) {
            break;
        }

        const unit = getMarkdownUnit(text, index);
        if (visibleLength + unit.visibleLength > maxLength) {
            break;
        }

        visibleLength += unit.visibleLength;
        index = unit.nextIndex;
        lastSafeBoundary = index;

        if (unit.visibleText === '\n') {
            if (prevVisibleChar === '\n') {
                paragraphPos = index;
                paragraphVisible = visibleLength;
            }
            newlinePos = index;
            newlineVisible = visibleLength;
        } else if (unit.visibleText && SENTENCE_ENDINGS.has(unit.visibleText)) {
            sentencePos = index;
            sentenceVisible = visibleLength;
        } else if (unit.visibleText === ' ') {
            spacePos = index;
            spaceVisible = visibleLength;
        }
        if (unit.visibleLength > 0 && unit.visibleText) {
            prevVisibleChar = unit.visibleText[unit.visibleText.length - 1] ?? '';
        }
    }

    // Paragraph break / newline anywhere past the floor wins over
    // sentence/space boundaries that are merely closer to the limit
    const visibleCap = Math.min(maxLength, visibleLength);
    const threshold = Math.floor(visibleCap * BOUNDARY_WINDOW_RATIO);
    const floor = Math.floor(visibleCap * NEWLINE_FLOOR_RATIO);
    if (paragraphPos && paragraphVisible >= floor) return paragraphPos;
    if (newlinePos && newlineVisible >= floor) return newlinePos;
    if (sentencePos && sentenceVisible >= threshold) return sentencePos;
    if (spacePos && spaceVisible >= threshold) return spacePos;

    // No boundary near the limit: fall back to the best boundary seen anywhere
    return newlinePos || sentencePos || spacePos || lastSafeBoundary
        || Math.min(text.length, TELEGRAM_RAW_HARD_LIMIT);
};

/**
 * Split text at optimal visible-length-aware boundary
 * Returns current part to send and remaining part for buffer
 */
export const smartSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): SplitResult => {
    if (
        getTelegramVisibleLength(text) <= maxLength &&
        text.length <= TELEGRAM_RAW_HARD_LIMIT
    ) {
        return {
            currentPart: text,
            remaining: '',
        };
    }

    const splitPos = findSplitPos(text, maxLength);

    return {
        currentPart: text.slice(0, splitPos),
        remaining: text.slice(splitPos),
    };
};

/**
 * Check if text needs splitting
 */
export const needsSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): boolean => {
    return (
        getTelegramVisibleLength(text) > maxLength ||
        text.length > TELEGRAM_RAW_HARD_LIMIT
    );
};

/** Weak boundaries: better than a mid-word cut, worse than a sentence end */
const WEAK_BOUNDARIES = new Set([' ', '，', ',', '、']);

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
 * Split RAW text so that the formatted first part fits maxVisible.
 *
 * Measures the actual formatted output (no expansion-factor guessing), so the
 * first part keeps everything already displayed on screen. The cut prefers a
 * paragraph/newline/sentence boundary within the last quarter before the limit.
 */
export const splitRawByFormattedLength = (
    raw: string,
    format: (text: string) => string,
    maxVisible: number
): SplitResult => {
    if (maxVisible <= 0) {
        return { currentPart: '', remaining: raw };
    }

    const fits = (length: number): boolean => {
        const formatted = format(raw.slice(0, length));
        return (
            getTelegramVisibleLength(formatted) <= maxVisible &&
            formatted.length <= TELEGRAM_RAW_HARD_LIMIT
        );
    };

    if (fits(raw.length)) {
        return { currentPart: raw, remaining: '' };
    }

    // Binary search the largest raw prefix whose formatted output fits
    // (formatted visible length is monotonic in the raw prefix length)
    let low = 0;
    let high = raw.length;
    while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (fits(mid)) {
            low = mid;
        } else {
            high = mid;
        }
    }

    const cutPos = low;
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
