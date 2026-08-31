/**
 * Streaming display of the model's thinking (CoT) as a rolling preview.
 *
 * The raw thinking text is segmented into sections (a heading plus its
 * paragraphs, Gemini's CoT shape; size-grouped when headingless). While the
 * model is still thinking, only the last two sections stay visible as plain
 * blockquotes; everything earlier collapses into an expandable blockquote
 * (Telegram re-collapses it on every edit), so the streamed message keeps a
 * roughly constant height. Once the answer starts, the whole thinking
 * collapses — the same shape the final render uses.
 */
import {
    concatMessages,
    renderMarkdown,
    wrapInBlockquote,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';

/** Above this size a paragraph is cut at a newline / sentence boundary */
const SEGMENT_SOFT_LIMIT = 400;
/** Above this size a paragraph is cut unconditionally */
const SEGMENT_HARD_LIMIT = 600;
/** Headingless paragraphs group into a section up to roughly this size,
 *  approximating the footprint of a Gemini heading + content section */
const SECTION_SOFT_LIMIT = 900;
/** How many trailing sections stay visible as the preview */
const PREVIEW_SEGMENT_COUNT = 2;
/** Up to this many sections the whole thinking shows uncollapsed */
const UNCOLLAPSED_SEGMENT_LIMIT = 3;

/** A heading line: markdown `#` heading or a lone bold line (Gemini style) */
const HEADING_LINE_PATTERN = /^(#{1,6}\s+\S.*|\*\*[^*\n]+\*\*[:：]?)$/;

const startsWithHeading = (unit: string): boolean => {
    const firstLine = unit.split('\n', 1)[0] ?? '';
    return HEADING_LINE_PATTERN.test(firstLine.trim());
};

/** CJK enders close a sentence by themselves; latin ones need whitespace */
const SENTENCE_END_PATTERN = /[。！？；]|[.!?](?=\s)/g;

/** End offset of the last full sentence inside `window`, or -1 */
const lastSentenceEnd = (window: string): number => {
    let end = -1;
    for (const match of window.matchAll(SENTENCE_END_PATTERN)) {
        end = match.index + match[0].length;
    }
    return end;
};

/**
 * Cut an oversized paragraph into segments close to a typical Gemini CoT
 * paragraph. Cut points only ever depend on a bounded prefix of the text, so
 * segmentation of already-streamed content never shifts as more arrives.
 */
const splitOversizedParagraph = (paragraph: string): string[] => {
    if (paragraph.length <= SEGMENT_SOFT_LIMIT) return [paragraph];

    const softWindow = paragraph.slice(0, SEGMENT_SOFT_LIMIT);
    let cut = softWindow.lastIndexOf('\n');
    if (cut <= 0) cut = lastSentenceEnd(softWindow);
    if (cut <= 0) {
        // No natural boundary: tolerate up to the hard limit, then cut at a
        // word boundary (CJK has none — a mid-text cut is the last resort)
        if (paragraph.length <= SEGMENT_HARD_LIMIT) return [paragraph];
        const hardWindow = paragraph.slice(0, SEGMENT_HARD_LIMIT);
        const wordBoundary = hardWindow.lastIndexOf(' ');
        cut = wordBoundary > 0 ? wordBoundary : SEGMENT_HARD_LIMIT;
    }

    const head = paragraph.slice(0, cut).trimEnd();
    const rest = paragraph.slice(cut).trimStart();
    if (!head || !rest) return [paragraph];
    return [head, ...splitOversizedParagraph(rest)];
};

/**
 * Split raw thinking text into display sections. A section is a heading plus
 * the paragraphs under it (Gemini's natural CoT shape). Paragraphs come from
 * blank lines, with a size fallback for platforms that stream long runs
 * without any; headingless paragraphs group by size instead, so every
 * platform ends up with Gemini-sized sections.
 */
export const segmentThinking = (raw: string): string[] => {
    const units: string[] = [];
    for (const paragraph of raw.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;
        units.push(...splitOversizedParagraph(trimmed));
    }

    // Group greedily: a heading opens a section and adopts what follows;
    // grouping decisions never look ahead, so streamed prefixes stay stable
    const sections: string[] = [];
    let current = '';
    for (const unit of units) {
        const overflows = current.length + unit.length > SECTION_SOFT_LIMIT;
        if (!current || startsWithHeading(unit) || overflows) {
            if (current) sections.push(current);
            current = unit;
        } else {
            current = `${current}\n\n${unit}`;
        }
    }
    if (current) sections.push(current);
    return sections;
};

export interface ThinkingStreamingOptions {
    /** Answer text has started: the thinking phase is over, collapse it all */
    answerStarted: boolean;
}

/**
 * Render the thinking buffer for the streaming (processing) view. Markdown is
 * always rendered in streaming mode: a segment cut can land inside an
 * unclosed construct.
 */
export const formatThinkingForStreaming = (
    thinking: string,
    options: ThinkingStreamingOptions
): RenderedMessage => {
    if (options.answerStarted) {
        return wrapInBlockquote(renderMarkdown(thinking, { streaming: true }), true);
    }

    const segments = segmentThinking(thinking);
    if (segments.length <= UNCOLLAPSED_SEGMENT_LIMIT) {
        return wrapInBlockquote(renderMarkdown(thinking, { streaming: true }), false);
    }

    const collapsed = segments.slice(0, -PREVIEW_SEGMENT_COUNT).join('\n\n');
    const preview = segments.slice(-PREVIEW_SEGMENT_COUNT).join('\n\n');
    return concatMessages(
        wrapInBlockquote(renderMarkdown(collapsed, { streaming: true }), true),
        '\n',
        wrapInBlockquote(renderMarkdown(preview, { streaming: true }), false)
    );
};
