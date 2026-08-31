/**
 * Streaming display of the model's thinking (CoT) as a rolling preview.
 *
 * The raw thinking text is segmented into paragraph-sized chunks. While the
 * model is still thinking, only the last two segments stay visible as plain
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
/** How many trailing segments stay visible as the preview */
const PREVIEW_SEGMENT_COUNT = 2;
/** Up to this many segments the whole thinking shows uncollapsed */
const UNCOLLAPSED_SEGMENT_LIMIT = 3;

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
 * Split raw thinking text into display segments: blank lines first (Gemini's
 * natural paragraphing), then a size fallback for platforms that stream long
 * runs without blank lines.
 */
export const segmentThinking = (raw: string): string[] => {
    const segments: string[] = [];
    for (const paragraph of raw.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;
        segments.push(...splitOversizedParagraph(trimmed));
    }
    return segments;
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
