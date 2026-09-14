/**
 * Quote rendering that keeps Telegram's block-nesting rule.
 *
 * A blockquote cannot render a block-level entity nested inside it: the client
 * cuts the quote short at the first nested `pre` and a quote that *starts* with
 * one is dropped altogether, so the quoted text falls back to ordinary message
 * body. That is exactly how a long CoT leaked into the message text — Gemini's
 * thinking indents nested bullet lists by four spaces, markdown reads that as an
 * indented code block (`pre`), and the thinking quote broke around it.
 *
 * Every quote built from markdown goes through here, so block entities are
 * flattened (the entity is dropped, its text stays) before the quote is applied.
 */
import { renderMarkdown, wrapInBlockquote } from 'telegram-md-entities';
import type { EntityType, RenderedMessage } from 'telegram-md-entities';

/** Entity types Telegram renders as blocks — no legal nesting inside a quote */
const BLOCK_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
    'pre',
    'blockquote',
    'expandable_blockquote',
]);

/**
 * Drop block entities while keeping their text. Only used on messages that are
 * about to be quoted as a whole, where every remaining entity is nested anyway.
 */
export const withoutBlockEntities = (message: RenderedMessage): RenderedMessage => ({
    text: message.text,
    entities: message.entities.filter((entity) => !BLOCK_ENTITY_TYPES.has(entity.type)),
});

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
        withoutBlockEntities(renderMarkdown(markdown, { streaming: options.streaming })),
        options.expandable
    );
