/**
 * Strips the `[#N]` label out of the model's own output.
 *
 * The context builder prefixes the bot's past replies with `[#5]` on its own
 * line so the model can refer to what it said before. The system prompt forbids
 * imitating that label, but the model still does it now and then, and a reply
 * that opens with "[#7]" leaks an internal annotation to the group — and, once
 * stored, teaches the next turn to do it again.
 *
 * Only the exact imitated shape is removed: the label alone on the first line.
 * A label used mid-sentence (`[#3] 说得对`) is a real reference the display layer
 * turns into a link, so it stays.
 */

/** `[#12]` alone on the first line, plus the blank space that follows it */
const LEADING_CONTEXT_LABEL = /^\s*\[#\d{1,3}\][ \t]*(\r?\n\s*|$)/;

/** Text that could still turn out to be a leading label once more arrives */
const POSSIBLE_LABEL_PREFIX = /^\s*(\[(#\d{0,3}\]?)?)?\s*$/;

/** Remove a leading standalone `[#N]` label from a complete reply text. */
export const stripContextLabel = (text: string): string =>
    text.replace(LEADING_CONTEXT_LABEL, '');

/**
 * Stateful stripper for streamed output: the label can arrive split across
 * chunks (`[`, `#2]`, `\n…`), so the opening is held back until there is enough
 * text to tell whether it is a label. Once real text has been emitted the
 * stripper is transparent for the rest of the stream.
 *
 * No flush is needed if the stream ends while text is still held back: what can
 * be held is only whitespace or a partial label, i.e. exactly what would have
 * been dropped anyway.
 */
export const createContextLabelStripper = (): ((chunk: string) => string) => {
    let held = '';
    let decided = false;

    return (chunk: string): string => {
        if (decided) return chunk;

        held += chunk;
        // Still nothing but (possibly) the start of a label — keep waiting
        if (POSSIBLE_LABEL_PREFIX.test(held)) return '';

        decided = true;
        const emitted = stripContextLabel(held);
        held = '';
        return emitted;
    };
};
