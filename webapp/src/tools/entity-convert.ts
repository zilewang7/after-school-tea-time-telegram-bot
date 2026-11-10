/**
 * The two conversion directions, as the UI uses them.
 *
 * Forward: markdown -> rendered entities -> clipboard HTML (+ plain text).
 * Reverse: clipboard HTML -> text + entities -> markdown.
 */
import { entitiesToMarkdown, renderMarkdown, toPreviewHtml } from 'telegram-md-entities';
import type { MessageEntity } from 'telegram-md-entities';
import { entitiesToClipboardHtml } from './clipboard-html';
import { parseClipboardHtml, trimBlockEntityNewlines } from './clipboard-parse';
import type { ClipboardConversion, ClipboardPayload, ClipboardTarget, RenderedMarkdown } from './types';

/**
 * Telegram keeps at most about 100 entities per message and drops the rest
 * silently. The UI warns a little below the cap because the server adds its
 * own entities for links, mentions and the like.
 */
export const MESSAGE_ENTITY_LIMIT = 100;

/** Warn from here: server-side auto entities eat into the headroom */
export const MESSAGE_ENTITY_WARN_LIMIT = 90;

/** Lenient markdown -> plain text plus Bot API entities */
export const markdownToRendered = (markdown: string): RenderedMarkdown => {
    const rendered = renderMarkdown(markdown);
    return { text: rendered.text, entities: rendered.entities };
};

/** Force every quote in a rendered message to one kind (normal or collapsible) */
export const withQuoteStyle = (rendered: RenderedMarkdown, collapsed: boolean): RenderedMarkdown => ({
    text: rendered.text,
    entities: rendered.entities.map((entity): MessageEntity => {
        if (entity.type !== 'blockquote' && entity.type !== 'expandable_blockquote') return entity;
        return { ...entity, type: collapsed ? 'expandable_blockquote' : 'blockquote' };
    }),
});

/** True when the message contains at least one quote */
export const hasQuote = (rendered: RenderedMarkdown): boolean =>
    rendered.entities.some((entity) => entity.type === 'blockquote' || entity.type === 'expandable_blockquote');

/** Rendered message -> the flavors a rich copy writes to the clipboard */
export const renderedToClipboardPayload = (
    rendered: RenderedMarkdown,
    target: ClipboardTarget
): ClipboardPayload => ({
    html: entitiesToClipboardHtml(rendered.text, rendered.entities, target),
    plainText: rendered.text,
});

/** Telegram-like preview bubble for the tool page (complete HTML, styles included) */
export const renderedToPreviewHtml = (rendered: RenderedMarkdown): string => toPreviewHtml(rendered);

/** Clipboard HTML from any Telegram client -> markdown for the user to reuse */
export const clipboardHtmlToMarkdown = (html: string): ClipboardConversion => {
    const parsed = parseClipboardHtml(html);
    // The clients cannot agree on a collapsed quote and the tool's markdown output
    // has no such construct either: render it as a normal quote.
    const markdownEntities = trimBlockEntityNewlines(parsed.text, parsed.entities).map((entity) =>
        entity.type === 'expandable_blockquote' ? { ...entity, type: 'blockquote' as const } : entity
    );
    const markdown = entitiesToMarkdown({ text: parsed.text, entities: markdownEntities });
    return {
        markdown,
        text: parsed.text,
        entities: markdownEntities,
        ignoredTags: parsed.ignoredTags,
        source: parsed.source,
    };
};
