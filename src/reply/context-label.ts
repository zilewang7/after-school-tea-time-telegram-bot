/**
 * Strips the annotations the context builder writes out of the model's output.
 *
 * The context builder marks the bot's own past replies with `[#5]` on its own
 * line so the model can refer to what it said before, and it annotates the
 * message being answered with `[replying to #2 某某]`. The system prompt forbids
 * imitating either shape. The model still does it now and then, and a marker
 * that reaches the group leaks an internal annotation — worse, once stored the
 * reply goes back into the context as an example and teaches the next turn to
 * do it again (observed in production: one slip then four replies in a row).
 *
 * The bracketed form has exactly one origin in the context, an annotation, while
 * a real reference is written without brackets (`#5`, `我在 #5 说过`) — that is
 * what the prompt asks for and what the display layer turns into a link. So
 * every shape below is an imitation and goes, and bare `#5` stays:
 *
 * - a label at the very start of the reply, standing on its own line
 *   (`[#7]\n…`) or glued to the text (`[#4] 哈哈确实…`, the shape that used to
 *   slip through), and the same for a leading `[replying to #2 某某]`;
 * - such an annotation occupying a whole line further down, which is the model
 *   using the marker as a turn separator (`…这就去查！\n[#61]\n好，查回来了…`).
 *
 * An annotation surrounded by text on both sides is left alone: it is written
 * inside a sentence, so it is a reference, and a reference is still clickable.
 */

/** `[#12]` at the very start, plus the line break / blank space that follows it */
const LEADING_CONTEXT_LABEL = /^\s*\[#\d{1,3}\][ \t]*(?:\r?\n\s*)?/;

/** `[replying to #2 某某]` at the very start, same deal */
const LEADING_REPLY_ANNOTATION = /^\s*\[replying to[^\]\n]*\][ \t]*(?:\r?\n\s*)?/;

/** Either annotation alone on its line, anywhere in the reply — line and break go too */
const ANNOTATION_ONLY_LINE = /^[ \t]*\[(?:#\d{1,3}|replying to[^\]\n]*)\][ \t]*(?:\r?\n|$)/gm;

/** Remove every imitated context annotation from a complete reply text. */
export const stripContextLabel = (text: string): string =>
    text
        .replace(LEADING_CONTEXT_LABEL, '')
        .replace(LEADING_REPLY_ANNOTATION, '')
        .replace(ANNOTATION_ONLY_LINE, '');

/** A `[#12` opening that has not finished arriving yet */
const PARTIAL_CONTEXT_LABEL = /^\s*\[#?\d{0,3}$/;

/** The other annotation's opening, for the same "still arriving" test */
const REPLY_ANNOTATION_OPENING = '[replying to';

/**
 * True while `held` is still nothing but a leading annotation — or the start of
 * one — plus blank space. That is the window where the streamed stripper must
 * not emit yet: the opening can arrive split across chunks (`[`, `#2]`, `\n…`),
 * and a leading annotation must also swallow the blank line after it.
 *
 * Anything else is real text and decides immediately: `[图片] 看看` is not an
 * annotation, and holding it would swallow the reply.
 */
const isLeadingAnnotationSoFar = (held: string): boolean => {
    const trimmed = held.replace(/^\s+/, '');
    if (trimmed === '') return true;
    if (trimmed.includes(']')) return stripContextLabel(held).trim() === '';
    // An annotation still arriving: `[`, `[#12`, `[reply…`, `[replying to #2 某某…`
    return (
        PARTIAL_CONTEXT_LABEL.test(trimmed) ||
        REPLY_ANNOTATION_OPENING.startsWith(trimmed) ||
        trimmed.startsWith(REPLY_ANNOTATION_OPENING)
    );
};

/**
 * Stateful stripper for streamed output. Once real text has been emitted the
 * stripper is transparent for the rest of the stream — an annotation further
 * down is `stripContextLabel`'s job on the assembled text.
 *
 * No flush is needed if the stream ends while text is still held back: what can
 * be held is only whitespace or a partial annotation, i.e. exactly what would
 * have been dropped anyway.
 */
export const createContextLabelStripper = (): ((chunk: string) => string) => {
    let held = '';
    let decided = false;

    return (chunk: string): string => {
        if (decided) return chunk;

        held += chunk;
        if (isLeadingAnnotationSoFar(held)) return '';

        decided = true;
        const emitted = stripContextLabel(held);
        held = '';
        return emitted;
    };
};
