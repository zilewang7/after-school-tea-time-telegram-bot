/**
 * The plain text of a rich message tree (rich blocks, or one RichText value),
 * for when the markdown renderer failed on it. A shape-blind walk over the
 * JSON, so it never throws, whatever a later Bot API puts in the tree.
 *
 * Only strings under the keys a reader sees as text are kept. Type names,
 * file ids, urls, alignments and user objects are skipped, so they never
 * reach the model as if the user had typed them.
 */

/** Keys whose value is visible text: a string or a RichText tree */
const TEXT_KEYS: ReadonlySet<string> = new Set([
    'text', // blocks, inline nodes, captions, table cells, buttons
    'credit', // quotes and captions
    'summary', // details
    'alternative_text', // custom emoji
    'expression', // formulas
    'file_name', // documents and audio files
]);

/** An inline run joins without a separator; blocks, cells and buttons go on lines of their own */
const joinParts = (parts: string[], inline: boolean): string =>
    parts.filter((part) => part.length > 0).join(inline ? '' : '\n');

const plainTextOf = (value: unknown, inline: boolean): string => {
    if (typeof value === 'string') return inline ? value : '';
    if (Array.isArray(value)) {
        return joinParts(value.map((item) => plainTextOf(item, inline)), inline);
    }
    if (typeof value !== 'object' || value === null) return '';
    return joinParts(
        Object.entries(value).map(([key, nested]) => plainTextOf(nested, TEXT_KEYS.has(key))),
        inline
    );
};

/** Plain text of rich message blocks, a line per block */
export const richBlocksPlainText = (blocks: unknown): string => plainTextOf(blocks, false);

/** Plain text of one RichText value, e.g. one entry of a quote's rich_texts */
export const richTextPlainText = (richText: unknown): string => plainTextOf(richText, true);
