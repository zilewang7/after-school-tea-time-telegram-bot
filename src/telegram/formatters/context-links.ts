/**
 * Display-time linkification of the `#N` context numbers the model writes in
 * its replies (the numbers context-builder puts on user messages).
 *
 * Runs on the already-rendered message, never on the markdown source and never
 * on the stored text: only `text_link` entities are appended, the text itself
 * is untouched. That keeps the length/entity budgets measured downstream exact,
 * lets code spans be skipped by looking at the entities instead of re-parsing
 * markdown, and leaves the persisted reply (and thus the next context) clean.
 */
import type { MessageEntity, RenderedMessage } from 'telegram-md-entities';

/**
 * `#` + 1-3 digits, glued to a word character on neither side, so `#4a90e2`,
 * `#4-5` and `#1234` are not taken for context references. Three digits is far
 * past any real context size.
 */
const CONTEXT_REFERENCE_PATTERN = /(?<![\w#])#(\d{1,3})(?![\w-])/g;

/** Spans that must stay verbatim (code) or are links already */
const OPAQUE_ENTITY_TYPES = new Set<MessageEntity['type']>(['code', 'pre', 'text_link']);

/** Resolve a context number to the link its message can be reached at */
export type ContextLinkResolver = (contextNumber: number) => string | undefined;

const overlapsOpaqueEntity = (
    entities: readonly MessageEntity[],
    offset: number,
    length: number
): boolean =>
    entities.some(
        (entity) =>
            OPAQUE_ENTITY_TYPES.has(entity.type) &&
            offset < entity.offset + entity.length &&
            entity.offset < offset + length
    );

/**
 * Turn every resolvable `#N` into a clickable link. Unresolvable numbers (the
 * model inventing `#99`) and numbers inside code or an existing link are left
 * as plain text.
 */
export const linkifyContextNumbers = (
    rendered: RenderedMessage,
    resolve: ContextLinkResolver | undefined
): RenderedMessage => {
    if (!resolve || !rendered.text) return rendered;

    const added: MessageEntity[] = [];

    for (const match of rendered.text.matchAll(CONTEXT_REFERENCE_PATTERN)) {
        const reference = match[0];
        const digits = match[1];
        if (match.index === undefined || digits === undefined) continue;

        const url = resolve(Number(digits));
        if (!url) continue;
        if (overlapsOpaqueEntity(rendered.entities, match.index, reference.length)) continue;

        added.push({
            type: 'text_link',
            offset: match.index,
            length: reference.length,
            url,
        });
    }

    if (!added.length) return rendered;

    // Keep entities offset-ordered (outer spans first) as the renderer emits them
    const entities = [...rendered.entities, ...added].sort(
        (a, b) => a.offset - b.offset || b.length - a.length
    );

    return { text: rendered.text, entities };
};
