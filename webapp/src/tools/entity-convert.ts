/**
 * The two conversion directions, as the UI uses them.
 *
 * Forward: markdown -> rendered entities -> clipboard HTML (+ plain text).
 * Reverse: clipboard HTML -> text + entities -> markdown.
 */
import { DEFAULT_MAX_LENGTH, entitiesToMarkdown, renderMarkdown, toPreviewHtml } from 'telegram-md-entities';
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

/**
 * Entity budget of a message the client is about to send.
 *
 * A Telegram client splitting a pasted message counts characters only: it does
 * not know where the entity budget falls. So the split is estimated at the
 * character limit and each part's entities are counted there — an entity that
 * crosses a cut counts in both parts, because the client restarts the style on
 * each side.
 */
export interface EntityBudget {
    /** Messages the client will send */
    parts: number;
    /** Entities in the busiest part */
    maxEntitiesPerPart: number;
    /** At least one part is close to the per-message cap */
    risk: boolean;
    /** At least one part is past the cap and loses entities on send */
    over: boolean;
}

const partOf = (offset: number, parts: number): number =>
    Math.min(parts - 1, Math.max(0, Math.floor(offset / DEFAULT_MAX_LENGTH)));

export const entityBudgetOf = (rendered: RenderedMarkdown): EntityBudget => {
    const textLength = rendered.text.length;
    const parts = Math.max(1, Math.ceil(textLength / DEFAULT_MAX_LENGTH));
    if (parts === 1) {
        const entities = rendered.entities.length;
        return {
            parts,
            maxEntitiesPerPart: entities,
            risk: entities >= MESSAGE_ENTITY_WARN_LIMIT,
            over: entities > MESSAGE_ENTITY_LIMIT,
        };
    }

    const counts = Array.from({ length: parts }, () => 0);
    for (const entity of rendered.entities) {
        const firstPart = partOf(entity.offset, parts);
        // max(0, …) keeps a zero-length entity inside its own part
        const lastPart = partOf(entity.offset + Math.max(0, entity.length - 1), parts);
        for (let part = firstPart; part <= lastPart; part += 1) {
            counts[part] = (counts[part] ?? 0) + 1;
        }
    }

    const maxEntitiesPerPart = counts.reduce((max, count) => Math.max(max, count), 0);
    return {
        parts,
        maxEntitiesPerPart,
        risk: maxEntitiesPerPart >= MESSAGE_ENTITY_WARN_LIMIT,
        over: maxEntitiesPerPart > MESSAGE_ENTITY_LIMIT,
    };
};

/**
 * Plain text -> markdown that renders back to the same text.
 *
 * The reverse direction's HTML path escapes by construction
 * (entitiesToMarkdown rebuilds markers from entities); the plain-text path has
 * no entities to infer, so every markdown character in the text has to be
 * escaped instead of being read as formatting. On iOS, whose clipboard copy
 * writes no HTML, `**` in the copied message is a literal two asterisks.
 *
 * Rules mirror the library's reverse-direction escape (rich/escape-markdown.ts):
 * the acceptance rule is renderMarkdown(escaped) showing the original text.
 */

/** Inline characters that can open constructs anywhere in a line */
const INLINE_SPECIALS = /[\\`*_[\]~|<>&]/g;

const escapeMarkdownLine = (line: string): string => {
    let escaped = line.replace(INLINE_SPECIALS, (char) => `\\${char}`);

    // Block starters only bite at the start of a line: ATX headings, list
    // bullets, hr / setext underlines. ('>' is already covered above.)
    escaped = escaped.replace(/^(\s*)([#+=-])/, '$1\\$2');
    // Ordered-list starters: "1. " / "1) "
    escaped = escaped.replace(/^(\s*)(\d+)([.)])(?=\s|$)/, '$1$2\\$3');
    // Four spaces of indentation would become an indented code block
    escaped = escaped.replace(/^ {4,}/, '   ');

    return escaped;
};

export const escapePlainMarkdown = (text: string): string =>
    text.split('\n').map(escapeMarkdownLine).join('\n');
