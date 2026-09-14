/**
 * Quote rendering for the model's chain of thought.
 *
 * Telegram renders inline entities only inside a quote: a block entity nested
 * in one makes the client cut the quote short, and a quote that starts with one
 * is dropped entirely — the CoT then leaks into the message body as plain text
 * (the 2026-09-14 incident). Two layers keep that from happening: the renderer
 * never emits a block entity inside a quote (telegram-md-entities ≥ 0.6.0), and
 * `wrapInBlockquote` flattens the ones a caller composes in.
 */
import { renderMarkdown, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import { normalizeThinkingIndent } from './thinking-markdown.js';

export interface QuotedMarkdownOptions {
    /** Collapse the quote behind a tap (Telegram's expandable blockquote) */
    expandable: boolean;
    /** Render a growing prefix: unclosed constructs show as their target style */
    streaming?: boolean;
}

/** Markdown → blockquote-wrapped message that Telegram can actually render */
export const renderQuotedMarkdown = (
    markdown: string,
    options: QuotedMarkdownOptions
): RenderedMessage =>
    wrapInBlockquote(
        renderMarkdown(markdown, { streaming: options.streaming }),
        options.expandable
    );

/**
 * Chain of thought → quote: `renderQuotedMarkdown` with the model's indentation
 * re-anchored first, so four-space sub-points render as nested bullets instead
 * of an indented code block.
 *
 * Callers that slice the thinking up (thinking-display) normalize the whole
 * text once and pass the slices to `renderQuotedMarkdown`: list levels are
 * tracked across lines, so normalizing each slice on its own would re-anchor
 * its first bullet as if it were top level.
 */
export const renderThinkingQuote = (
    thinking: string,
    options: QuotedMarkdownOptions
): RenderedMessage => renderQuotedMarkdown(normalizeThinkingIndent(thinking), options);
