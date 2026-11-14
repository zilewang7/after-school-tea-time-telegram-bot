/**
 * Display-time linkification of the `#N` context numbers the model writes in
 * its replies (the numbers context-builder puts on user messages).
 *
 * Runs on the already-rendered message, never on the markdown source and never
 * on the stored text: only `text_link` entities are appended, the text itself
 * is untouched. That keeps the length/entity budgets measured downstream exact,
 * lets code spans be skipped by looking at the entities instead of re-parsing
 * markdown, and leaves the persisted reply (and thus the next context) clean.
 *
 * A rich answer goes to Telegram as markdown instead: toRichMarkdown finds the
 * same references in each run of plain text (contextTextLinker) and wraps
 * them in links there, display only as well.
 */
import type { MessageEntity, RenderedMessage, TextLinker } from 'telegram-md-entities';

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

/** A resolvable `#N` in a text */
interface ContextReference {
    readonly offset: number;
    readonly length: number;
    readonly url: string;
}

/** Every `#N` of text that resolves; the model inventing `#99` resolves to nothing */
const findContextReferences = (text: string, resolve: ContextLinkResolver): ContextReference[] => {
    const found: ContextReference[] = [];
    for (const match of text.matchAll(CONTEXT_REFERENCE_PATTERN)) {
        const digits = match[1];
        if (match.index === undefined || digits === undefined) continue;
        const url = resolve(Number(digits));
        if (url) found.push({ offset: match.index, length: match[0].length, url });
    }
    return found;
};

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

    const added = findContextReferences(rendered.text, resolve)
        .filter((reference) => !overlapsOpaqueEntity(rendered.entities, reference.offset, reference.length))
        .map(
            (reference): MessageEntity => ({
                type: 'text_link',
                offset: reference.offset,
                length: reference.length,
                url: reference.url,
            })
        );

    if (!added.length) return rendered;

    // Keep entities offset-ordered (outer spans first) as the renderer emits them
    const entities = [...rendered.entities, ...added].sort(
        (a, b) => a.offset - b.offset || b.length - a.length
    );

    return { text: rendered.text, entities };
};

/**
 * The same links for toRichMarkdown's `textLinks`: it calls this with each run
 * of plain text of a rich answer (code and existing links never reach it; it
 * drops a range inside math itself), plus the character a reader sees on
 * either side of the run, so `#3` right after `**Alice**` stays text as in
 * `Alice#3` on the entities path. A reference reaching past the run (`#1`
 * before a bold `2`) is left out. undefined where there is nothing to resolve
 * against.
 */
export const contextTextLinker = (resolve: ContextLinkResolver | undefined): TextLinker | undefined =>
    resolve === undefined
        ? undefined
        : (text, { before, after }) =>
              findContextReferences(`${before}${text}${after}`, resolve)
                  .map((reference) => ({ ...reference, offset: reference.offset - before.length }))
                  .filter((reference) => reference.offset >= 0 && reference.offset + reference.length <= text.length);
