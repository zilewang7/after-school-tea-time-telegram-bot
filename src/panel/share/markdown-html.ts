/**
 * Markdown to safe HTML for the public share page (design §5.7).
 *
 * The markdown is the bot's stored reply text (or a user's message text on a
 * conversation share). It goes through telegram-md-entities' renderer, which
 * turns it into plain text plus entities; this module maps the whitelisted
 * entity types to semantic tags and escapes every piece of text. Unknown
 * entities are dropped, never interpreted. Links must be http(s)/tg.
 */
import { match } from 'ts-pattern';
import { renderMarkdown, type MessageEntity } from 'telegram-md-entities';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

/** Only these schemes may become an anchor; anything else stays plain text */
export const isSafeLinkUrl = (url: string): boolean => /^(https?|tg):/i.test(url.trim());

interface TagPair {
    open: string;
    close: string;
}

const anchorOf = (url: string | undefined): TagPair | null => {
    if (url === undefined || !isSafeLinkUrl(url)) return null;
    return {
        open: `<a href="${escapeHtml(url.trim())}" target="_blank" rel="noopener noreferrer nofollow">`,
        close: '</a>',
    };
};

const tagPairOf = (entity: MessageEntity): TagPair | null =>
    match(entity)
        .with({ type: 'bold' }, () => ({ open: '<strong>', close: '</strong>' }))
        .with({ type: 'italic' }, () => ({ open: '<em>', close: '</em>' }))
        .with({ type: 'underline' }, () => ({ open: '<u>', close: '</u>' }))
        .with({ type: 'strikethrough' }, () => ({ open: '<s>', close: '</s>' }))
        .with({ type: 'code' }, () => ({ open: '<code>', close: '</code>' }))
        .with({ type: 'pre' }, (pre) =>
            pre.language === undefined || pre.language === ''
                ? { open: '<pre><code>', close: '</code></pre>' }
                : { open: `<pre><code class="language-${escapeHtml(pre.language)}">`, close: '</code></pre>' }
        )
        .with({ type: 'blockquote' }, () => ({ open: '<blockquote>', close: '</blockquote>' }))
        .with({ type: 'expandable_blockquote' }, () => ({
            open: '<blockquote class="expandable">',
            close: '</blockquote>',
        }))
        .with({ type: 'spoiler' }, () => ({ open: '<span class="tg-spoiler">', close: '</span>' }))
        .with({ type: 'text_link' }, (link) => anchorOf(link.url))
        .otherwise(() => null);

/** One entity range, sorted outermost-first so nesting can be rebuilt */
interface SpanNode {
    start: number;
    end: number;
    entity: MessageEntity;
    children: SpanNode[];
}

const spanOf = (entity: MessageEntity, textLength: number): SpanNode | null => {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end <= start || end > textLength) return null;
    return { start, end, entity, children: [] };
};

/**
 * Rebuild the nesting of Telegram entities. renderMarkdown produces properly
 * nested ranges; should a hand-built entity overlap, it is clipped to its
 * parent rather than emitted as broken HTML.
 */
const buildTree = (nodes: SpanNode[]): SpanNode[] => {
    const roots: SpanNode[] = [];
    const stack: SpanNode[] = [];
    for (const node of nodes) {
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            if (top === undefined || node.start < top.end) break;
            stack.pop();
        }
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
            roots.push(node);
        } else if (node.end <= parent.end) {
            parent.children.push(node);
        } else if (parent.end > node.start) {
            parent.children.push({ ...node, end: parent.end });
            continue;
        } else {
            roots.push(node);
        }
        stack.push(node);
    }
    return roots;
};

const renderRange = (text: string, from: number, to: number, nodes: readonly SpanNode[]): string => {
    let html = '';
    let cursor = from;
    for (const node of nodes) {
        if (node.start > cursor) html += escapeHtml(text.slice(cursor, node.start));
        const inner = renderRange(text, node.start, node.end, node.children);
        const pair = tagPairOf(node.entity);
        html += pair === null ? inner : `${pair.open}${inner}${pair.close}`;
        cursor = node.end;
    }
    if (cursor < to) html += escapeHtml(text.slice(cursor, to));
    return html;
};

/** Rendered text plus entities (as renderMarkdown returns them) → HTML */
export const entitiesToHtml = (text: string, entities: readonly MessageEntity[]): string => {
    const nodes = entities
        .flatMap((entity) => {
            const node = spanOf(entity, text.length);
            return node === null ? [] : [node];
        })
        .sort((a, b) => a.start - b.start || b.end - a.end);
    return renderRange(text, 0, text.length, buildTree(nodes));
};

/** Stored markdown → HTML, with everything but the whitelisted markup escaped */
export const markdownToHtml = (markdown: string): string => {
    if (markdown === '') return '';
    const rendered = renderMarkdown(markdown);
    return entitiesToHtml(rendered.text, rendered.entities);
};

/** A short plain-text excerpt of stored markdown (OG description, card subtitle) */
export const markdownExcerpt = (markdown: string, maxLength: number): string => {
    const rendered = renderMarkdown(markdown);
    const flat = rendered.text.replace(/\s+/g, ' ').trim();
    return flat.length <= maxLength ? flat : `${flat.slice(0, Math.max(0, maxLength - 1))}…`;
};
