/**
 * Long chain of thought → one compact link message.
 *
 * A CoT that already fills a whole Telegram message used to be split into
 * several quote-stuffed messages. The reply now opens with one message whose
 * visible text is a single link (opens the Mini App thinking page), whose
 * link preview opens the faster plain SSR page — the same two-entry split as
 * the widget fallback (text_link → Mini App, link_preview_options → fast page).
 *
 * Once the thinking is done, one italic line under the link says how much CoT
 * the link hides: its word count and how many Telegram messages the pre-link
 * layout would have split it into. Streaming keeps a rolling preview quote
 * instead; the state machine decides when each shape is shown.
 */
import { concatMessages, splitMessage } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { LinkPreviewOptions } from '../link-preview.js';
import { italicText } from './entity-text.js';
import { TELEGRAM_MAX_ENTITIES, TELEGRAM_MAX_LENGTH } from './message-budget.js';
import { renderThinkingQuote } from './quoted-render.js';
import type { FinalMessageChunk } from './final-message-builder.js';
import type { ThinkingLinkRef } from '../../panel/thinking/thinking-link-service.js';

/** The thinking-link contract lives with its service (design §8.1); re-exported here */
export type { ThinkingLinkRef };

/** The whole visible text of the link (the emoji is part of the link) */
export const THINKING_LINK_LABEL = '🧠 查看完整思考过程';

/** What the hidden CoT costs the reader, as the line under the link states it */
export interface ThinkingLinkSummary {
    /** Words in the CoT (Chinese and English alike) */
    words: number;
    /** Telegram messages the pre-link layout would have split the CoT into */
    segments: number;
}

/** Chinese/English word segmentation: what "how many words" means for a CoT */
const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

const countWords = (text: string): number => {
    let words = 0;
    for (const segment of WORD_SEGMENTER.segment(text)) {
        if (segment.isWordLike === true) words += 1;
    }
    return words;
};

/**
 * A CoT longer than this is measured from its beginning and scaled up. The
 * markdown renderer's cost grows faster than its input, so rendering a 500k
 * character CoT just to count its messages would block the reply for seconds;
 * the line already says "约拆成", so a scaled count is honest.
 */
const SUMMARY_SAMPLE_CHARS = 20_000;

/** The measured part of a CoT and how many times it fits into the whole */
interface SummarySample {
    readonly text: string;
    readonly scale: number;
}

/** The first SUMMARY_SAMPLE_CHARS, cut back to a paragraph boundary */
const summarySampleOf = (thinking: string): SummarySample => {
    if (thinking.length <= SUMMARY_SAMPLE_CHARS) return { text: thinking, scale: 1 };
    const window = thinking.slice(0, SUMMARY_SAMPLE_CHARS);
    const cut = window.lastIndexOf('\n\n');
    const text = cut <= 0 ? window : window.slice(0, cut);
    return { text, scale: thinking.length / text.length };
};

/**
 * The stats of a finished thinking: its word count, plus the number of messages
 * the layout before the link would have taken (the same render and budgets the
 * final split uses; scaled up from a sample for a very long CoT). Null when
 * there is nothing to count, or when measuring fails — the link message then
 * simply keeps its label-only shape.
 */
export const thinkingLinkSummaryOf = (thinking: string): ThinkingLinkSummary | null => {
    if (thinking.trim() === '') return null;
    try {
        const sample = summarySampleOf(thinking);
        const sampleSegments = splitMessage(renderThinkingQuote(sample.text, { expandable: true }), {
            maxLength: TELEGRAM_MAX_LENGTH,
            maxEntities: TELEGRAM_MAX_ENTITIES,
        }).length;
        return {
            words: countWords(thinking),
            segments: Math.max(1, Math.round(sampleSegments * sample.scale)),
        };
    } catch (error) {
        console.warn('[thinking-link] measuring the thinking failed:', error);
        return null;
    }
};

/** `共 7,689 词，发出约拆成 16 段` */
export const thinkingLinkSummaryLine = (summary: ThinkingLinkSummary): string =>
    `共 ${summary.words.toLocaleString('zh-CN')} 词，发出约拆成 ${summary.segments} 段`;

/**
 * Preview card of the link message: the fast page, shown below the text. No
 * large media — the page has no og:image, so Telegram renders a text card.
 */
export const thinkingLinkPreviewOptions = (ref: ThinkingLinkRef): LinkPreviewOptions => ({
    url: ref.fastPageUrl,
    show_above_text: false,
});

/**
 * Terminal link message: the Mini App link, then (once the thinking is done)
 * the italic stats line. Without a summary the message is the bare link, which
 * is what an old or immeasurable thinking keeps.
 */
export const renderThinkingLinkMessage = (
    ref: ThinkingLinkRef,
    summary?: ThinkingLinkSummary
): RenderedMessage => {
    const link: RenderedMessage = {
        text: THINKING_LINK_LABEL,
        entities: [
            {
                type: 'text_link',
                offset: 0,
                length: THINKING_LINK_LABEL.length,
                url: ref.miniAppUrl,
            },
        ],
    };
    if (summary === undefined) return link;
    // Directly on the next line: the stats are the link's subtitle, not a
    // separate paragraph
    return concatMessages(link, '\n', italicText(thinkingLinkSummaryLine(summary)));
};

/**
 * Streaming link message: the link, then the caller-rendered thinking preview
 * (a bare blockquote — see formatThinkingPreviewForLink) on the very next line,
 * so the message keeps a roughly constant height while the CoT grows.
 */
export const renderThinkingLinkStreaming = (
    ref: ThinkingLinkRef,
    preview: RenderedMessage
): RenderedMessage =>
    preview.text
        ? concatMessages(renderThinkingLinkMessage(ref), '\n', preview)
        : renderThinkingLinkMessage(ref);

/** Terminal chunk for buildFinalMessages / version replay, preview card included */
export const toThinkingLinkChunk = (
    ref: ThinkingLinkRef,
    summary?: ThinkingLinkSummary
): FinalMessageChunk => ({
    ...renderThinkingLinkMessage(ref, summary),
    linkPreviewOptions: thinkingLinkPreviewOptions(ref),
});
