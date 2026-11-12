/**
 * Removes the raw PerQueryResult citation markers Gemini writes for its
 * `google:search` / `google:browse` results (`[1.2.3]`, `[1.4.1][1.4.5]`).
 *
 * Google's own system prompt for those tools requires every claim to end with
 * such a marker. Normally the API consumes them: the text arrives without the
 * markers and the sources come back as grounding metadata, which the reply
 * renders as superscripts. But a long tool loop can end on an answer round
 * that carries no grounding metadata at all (measured 2026-11-12: the answer
 * round of a 16-round reply had none, while every earlier round reported only
 * search queries), and then nothing consumes the markers — they reach the
 * group verbatim and read as `[1.4.1]` junk. Without the grounding mapping the
 * numbers mean nothing to a reader, so they are dropped from the body. Over the
 * stored replies of 2026-11-12 that hit four of thirty-two hydrogen replies,
 * one of 260 argon and one of 87 carbon.
 *
 * A chat addendum that forbids the markers is not a fix: the model still
 * follows Google's MUST instruction now and then (the 09:10 reply leaked with
 * the addendum already in place), and the two instructions contradict each
 * other. This is the harness-side cleanup the contradiction asks for.
 *
 * Code spans and fenced blocks are content, not prose — `🇺🇸 美国极限优化 [2.5]`
 * is a node name — and link text (`[1.2](url)`) must keep its label. A dotted
 * number in prose (`[1.2, 2.5]` as an interval) would be caught as well; that
 * shape has not been observed outside citations and is accepted as the cost of
 * a marker that cannot be told apart from one.
 */

/** One or more `1.2` / `1.2.3` indices, comma separated, plus the spaces before it */
const CITATION_MARKER = /[ \t]*\[\d+(?:\.\d+){1,3}(?:\s*,\s*\d+(?:\.\d+){1,3})*\]/g;

/** The same shape without the leading spaces, for the "anything to strip" test */
const CITATION_CANDIDATE = /\[\d+(?:\.\d+){1,3}(?:\s*,\s*\d+(?:\.\d+){1,3})*\]/;

/** An opening fence: up to three spaces, then three or more backticks or tildes */
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/;

/** Marks every character of `text` that sits inside a code span or fenced block */
const codeMask = (text: string): Uint8Array => {
    const mask = new Uint8Array(text.length);
    let fence: string | null = null;
    let lineStart = 0;

    for (;;) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);

        if (fence !== null) {
            mask.fill(1, lineStart, lineEnd);
            if (line.trimStart().startsWith(fence)) fence = null;
        } else {
            const opening = FENCE_OPENING.exec(line);
            if (opening !== null) {
                fence = opening[1] ?? '```';
                mask.fill(1, lineStart, lineEnd);
            } else {
                markInlineCode(text, lineStart, lineEnd, mask);
            }
        }

        if (newline === -1) break;
        lineStart = newline + 1;
    }

    return mask;
};

/** Marks the inline code spans of one line; an unclosed span protects the rest of it */
const markInlineCode = (text: string, lineStart: number, lineEnd: number, mask: Uint8Array): void => {
    let position = lineStart;
    while (position < lineEnd) {
        const opening = text.indexOf('`', position);
        if (opening === -1 || opening >= lineEnd) return;
        let runEnd = opening;
        while (runEnd < lineEnd && text[runEnd] === '`') runEnd += 1;
        const run = text.slice(opening, runEnd);
        const closing = text.indexOf(run, runEnd);
        if (closing === -1 || closing + run.length > lineEnd) {
            mask.fill(1, opening, lineEnd);
            return;
        }
        mask.fill(1, opening, closing + run.length);
        position = closing + run.length;
    }
};

/**
 * A removed marker may have been the only separator between two ASCII words
 * (`word [1.2] more`): keep one space so they do not run together. Chinese and
 * punctuation need none.
 */
const needsWordSeparator = (before: string, after: string): boolean =>
    /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(after);

/** Remove every raw PerQueryResult citation marker from a reply body */
export const stripPerQueryResultCitations = (text: string): string => {
    if (!CITATION_CANDIDATE.test(text)) return text;

    const mask = codeMask(text);
    return text.replace(CITATION_MARKER, (match: string, offset: number) => {
        const markerStart = offset + (match.length - match.trimStart().length);
        if (mask[markerStart] === 1) return match;
        const markerEnd = offset + match.length;
        if (text[markerEnd] === '(') return match;
        if (text[markerStart - 1] === '!') return match;
        return needsWordSeparator(
            text.slice(Math.max(0, offset - 1), offset),
            text.slice(markerEnd, markerEnd + 1)
        )
            ? ' '
            : '';
    });
};
