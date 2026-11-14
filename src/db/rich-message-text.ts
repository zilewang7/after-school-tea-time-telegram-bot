/**
 * Rich text users send → the markdown stored for the context tree: the blocks
 * of a rich message (Bot API 10.1+) and the rich text of a quote chosen from
 * one (10.4).
 *
 * Both are JSON the server keeps extending. telegram-md-entities renders the
 * shapes it does not know as their text; should it still throw on one, the
 * plain text is stored instead, so no Bot API change can drop a message.
 */
import type { RichBlock, RichMessage, TextQuote } from 'grammy/types';
import { richBlocksToMarkdown, richTextToMarkdown, type RichTextNode } from 'telegram-md-entities';
import { richBlocksPlainText, richTextPlainText } from './rich-plain-text.js';

/** Rich blocks → markdown; injectable so the offline cases can make it throw */
export type RichBlocksRenderer = (blocks: RichBlock[]) => string;

/** The rendered markdown, or the plain text when the renderer throws */
const renderedOrPlainText = (
    render: () => string,
    plainText: () => string,
    subject: string
): string => {
    try {
        return render();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[autoSave] ${subject} could not be rendered, stored as plain text: ${reason}`);
        return plainText();
    }
};

const nonEmpty = (text: string): string | undefined => {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

/** Rich messages (Premium rich text editor, Bot API 10.1+) → markdown */
export const renderRichMessage = (
    richMessage: RichMessage | undefined,
    messageKey: string,
    renderBlocks: RichBlocksRenderer = richBlocksToMarkdown
): string | undefined => {
    if (!richMessage) return undefined;
    const { blocks } = richMessage;
    return nonEmpty(renderedOrPlainText(
        () => renderBlocks(blocks),
        () => richBlocksPlainText(blocks),
        `rich message ${messageKey}`
    ));
};

/** One RichText → markdown; injectable so the offline cases can make it throw */
export type RichTextRenderer = (richText: RichTextNode) => string;

/**
 * TextQuote.rich_texts: the quote was chosen from a rich message (Bot API
 * 10.4). grammy 1.46 does not declare it yet, so it is read structurally.
 */
const quoteRichTexts = (quote: TextQuote): RichTextNode[] | undefined => {
    if (!('rich_texts' in quote)) return undefined;
    const richTexts: unknown = quote.rich_texts;
    return Array.isArray(richTexts) ? richTexts : undefined;
};

/**
 * Each entry of rich_texts is a quoted text of its own, in the order they
 * appear (a paragraph, a heading, a table cell, a caption...): a line each,
 * or two paragraphs would run together.
 */
const joinQuotedTexts = (parts: readonly string[]): string =>
    parts.filter((part) => part.trim().length > 0).join('\n');

/** Markdown of a quote's rich_texts; undefined when it has none or they hold no text */
export const renderQuoteRichTexts = (
    quote: TextQuote,
    messageKey: string,
    renderRichText: RichTextRenderer = richTextToMarkdown
): string | undefined => {
    const richTexts = quoteRichTexts(quote);
    if (richTexts === undefined) return undefined;
    return nonEmpty(renderedOrPlainText(
        () => joinQuotedTexts(richTexts.map((entry) => renderRichText(entry))),
        () => joinQuotedTexts(richTexts.map((entry) => richTextPlainText(entry))),
        `the quote of message ${messageKey}`
    ));
};
