/**
 * Strips the `[#N]` label out of the model's own output.
 *
 * The context builder marks the bot's own past replies with `[#5]` on its own
 * line so the model can refer to what it said before, and the system prompt
 * forbids imitating that label. The model still does it now and then, and a
 * marker that reaches the group leaks an internal annotation — worse, once
 * stored it teaches the next turn to do it again.
 *
 * The bracketed form has exactly one origin in the context, the assistant turn
 * marker (see `buildAssistantMessage`), while a real reference is written
 * without brackets (`#5`, `我在 #5 说过`) — that is what the prompt asks for and
 * what the display layer turns into a link. So both shapes below are imitations
 * and go, and bare `#5` stays:
 *
 * - a label at the very start of the reply, standing on its own line
 *   (`[#7]\n…`) or glued to the text (`[#4] 哈哈确实…`, the shape that used to
 *   slip through);
 * - a label occupying a whole line further down, which is the model using the
 *   marker as a turn separator (`…这就去查！\n[#61]\n好，查回来了…`).
 *
 * A label surrounded by text on both sides is left alone: it is written inside
 * a sentence, so it is a reference, and a reference is still clickable.
 */

/** `[#12]` at the very start, plus the line break / blank space that follows it */
const LEADING_CONTEXT_LABEL = /^\s*\[#\d{1,3}\][ \t]*(?:\r?\n\s*)?/;

/** `[#12]` alone on its line, anywhere in the reply — line and break go too */
const LABEL_ONLY_LINE = /^[ \t]*\[#\d{1,3}\][ \t]*(?:\r?\n|$)/gm;

/** Text that could still turn out to be a leading label once more arrives */
const POSSIBLE_LABEL_PREFIX = /^\s*(\[(#\d{0,3}\]?)?)?\s*$/;

/** Remove every imitated `[#N]` label from a complete reply text. */
export const stripContextLabel = (text: string): string =>
    text.replace(LEADING_CONTEXT_LABEL, '').replace(LABEL_ONLY_LINE, '');

/**
 * Stateful stripper for streamed output: the label can arrive split across
 * chunks (`[`, `#2]`, `\n…`), so the opening is held back until there is enough
 * text to tell whether it is a label. Once real text has been emitted the
 * stripper is transparent for the rest of the stream — a label further down is
 * `stripContextLabel`'s job on the assembled text.
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
        const emitted = held.replace(LEADING_CONTEXT_LABEL, '');
        held = '';
        return emitted;
    };
};
