/**
 * Superscript citation markers for search grounding.
 *
 * Gemini reports the slice of the reply each source backs as `segment.text`, a
 * verbatim slice: the numeric offsets cannot be used (UTF-8 bytes into one
 * part, and `startIndex` is often absent), so the text is searched for in the
 * assembled reply.
 *
 * The markers are inserted into the markdown source as `[¹](url)`, which lets
 * renderMarkdown compute the entity offsets. Mapping source positions onto
 * rendered text ourselves would be the fragile step of this feature, and it is
 * avoidable.
 */
import type { GroundingSupportData } from '../../ai/types.js';
import { isLinkableSourceUrl, type GroundingSourceList } from './grounding-sources.js';

/**
 * Between two numbers of one segment: a narrow no-break space, which reads as
 * the thin space but never lets a line break split `¹ ²`.
 */
const CITATION_SEPARATOR = '\u202F';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/**
 * Sentence enders a marker moves past: a citation reads better after `。` than
 * before it. Commas and semicolons are deliberately absent — a marker belongs
 * at the end of the claim, not after a clause separator.
 */
const CLOSING_PUNCTUATION = new Set([
    '。',
    '．',
    '！',
    '!',
    '？',
    '?',
    '…',
    '”',
    '’',
    '」',
    '』',
    '）',
    ')',
    '】',
    '》',
    '"',
    "'",
]);

/** A segment located in the reply, ready to be marked */
interface CitationStop {
    start: number;
    end: number;
    /** Where the marker goes: after the segment, past its closing punctuation */
    insertAt: number;
    numbers: number[];
}

const toSuperscript = (number: number): string =>
    String(number)
        .split('')
        .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit)
        .join('');

/**
 * Parentheses and whitespace end a markdown destination early; percent-encoding
 * them keeps the link intact and points at the same URL.
 */
const escapeMarkdownDestination = (uri: string): string =>
    uri.replace(/[\s()<>]/g, (character) => encodeURIComponent(character));

const markdownForNumber = (number: number, urlByNumber: ReadonlyMap<number, string>): string => {
    const superscript = toSuperscript(number);
    const uri = urlByNumber.get(number);
    if (uri === undefined || !isLinkableSourceUrl(uri)) return superscript;
    return `[${superscript}](${escapeMarkdownDestination(uri)})`;
};

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/** Whether a marker may be inserted at this position without breaking markup */
const canInsertAt = (text: string, position: number): boolean => {
    const before = text.slice(0, position);

    // An unclosed ``` fence turns everything after it into literal text
    if (countOccurrences(before, '```') % 2 === 1) return false;

    // Inline code span on this line
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (countOccurrences(line, '`') % 2 === 1) return false;

    // Link text of an unclosed [ ... ]
    if (before.lastIndexOf('[') > before.lastIndexOf(']')) return false;

    // Destination of the last ]( ... ), while its ')' has not been passed yet
    const destinationStart = before.lastIndexOf('](');
    if (destinationStart >= 0) {
        const destinationEnd = text.indexOf(')', destinationStart + 2);
        if (destinationEnd === -1 || destinationEnd >= position) return false;
    }

    // Inside an HTML tag or an autolink
    if (before.lastIndexOf('<') > before.lastIndexOf('>')) return false;

    return true;
};

const insertionPoint = (text: string, end: number): number => {
    let position = end;
    while (position < text.length && CLOSING_PUNCTUATION.has(text[position] ?? '')) {
        position += 1;
    }
    return position;
};

/**
 * The segment's position, searched forward from the previous one so repeated
 * sentences keep their order. A repeat of an earlier sentence falls back to
 * its first occurrence; overlap merging then resolves the conflict.
 */
const locateSegment = (text: string, segmentText: string, from: number): number | null => {
    const forward = text.indexOf(segmentText, from);
    if (forward >= 0) return forward;
    const anywhere = text.indexOf(segmentText);
    return anywhere >= 0 ? anywhere : null;
};

const citationNumbers = (support: GroundingSupportData, sourceList: GroundingSourceList): number[] => {
    const numbers = (support.groundingChunkIndices ?? [])
        .map((chunkIndex) => sourceList.numberByChunk.get(chunkIndex))
        .filter((number): number is number => number !== undefined);
    return [...new Set(numbers)].sort((left, right) => left - right);
};

/**
 * Two supports can cover the same claim (Google reports a nested and a wider
 * segment for the same line): one marker group, the union of their numbers.
 */
const mergeOverlappingStops = (stops: readonly CitationStop[]): CitationStop[] => {
    const sorted = [...stops].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: CitationStop[] = [];

    for (const stop of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && stop.start < last.end) {
            last.end = Math.max(last.end, stop.end);
            last.insertAt = Math.max(last.insertAt, stop.insertAt);
            last.numbers = [...new Set([...last.numbers, ...stop.numbers])].sort(
                (left, right) => left - right
            );
            continue;
        }
        merged.push({ ...stop, numbers: [...stop.numbers] });
    }

    return merged;
};

const collectStops = (
    text: string,
    sourceList: GroundingSourceList,
    supports: readonly GroundingSupportData[]
): CitationStop[] => {
    const stops: CitationStop[] = [];
    let cursor = 0;

    for (const support of supports) {
        // Trailing whitespace would put the marker at the start of the next
        // paragraph instead of after this sentence
        const segmentText = support.segment?.text?.trim();
        if (!segmentText) continue;

        const start = locateSegment(text, segmentText, cursor);
        if (start === null) continue;
        cursor = start + segmentText.length;

        const numbers = citationNumbers(support, sourceList);
        if (numbers.length === 0) continue;

        const insertAt = insertionPoint(text, start + segmentText.length);
        if (!canInsertAt(text, insertAt)) continue;

        stops.push({ start, end: start + segmentText.length, insertAt, numbers });
    }

    return stops;
};

/**
 * The reply with a superscript marker group at the end of every grounded
 * segment, each number linking to the page it stands for. Unchanged when the
 * step has no supports, when no segment can be found, or when the only match
 * sits somewhere a marker would break the markdown.
 */
export const inlineCitations = (
    text: string,
    sourceList: GroundingSourceList,
    supports: readonly GroundingSupportData[] | undefined
): string => {
    if (!text || !supports?.length || sourceList.sources.length === 0) return text;

    const stops = collectStops(text, sourceList, supports);
    if (stops.length === 0) return text;

    const urlByNumber = new Map(sourceList.sources.map((source) => [source.number, source.uri]));
    const merged = mergeOverlappingStops(stops).sort(
        (left, right) => right.insertAt - left.insertAt
    );

    return merged.reduce((output, stop) => {
        const markers = stop.numbers
            .map((number) => markdownForNumber(number, urlByNumber))
            .join(CITATION_SEPARATOR);
        return `${output.slice(0, stop.insertAt)}${markers}${output.slice(stop.insertAt)}`;
    }, text);
};
