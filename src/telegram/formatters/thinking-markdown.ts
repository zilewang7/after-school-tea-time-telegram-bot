/**
 * Re-anchor the indentation of a chain of thought so markdown reads it the way
 * the model meant it.
 *
 * Gemini indents sub-points by four spaces. After a blank line that indentation
 * is a CommonMark indented code block: the bullet markers stay literal, bold
 * never renders, and the resulting `pre` used to break the thinking quote and
 * leak the CoT into the message body (see quoted-render.ts). Re-anchoring every
 * list marker line to a legal nesting depth keeps bullets, bold and structure.
 *
 * The transform only looks backwards, one line at a time, so a streaming buffer
 * renders exactly like its final text: the output of a line never changes as
 * more text arrives.
 */

/** Spaces per nesting level — the renderer's own nested-bullet indentation */
const INDENT_STEP = 4;

/** A list item marker as LLMs write them: bullet or ordered */
const LIST_MARKER_PATTERN = /^(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** Fence opener: ``` / ~~~ (three or more), at most 3 spaces in */
const FENCE_OPENER_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** Fence closer: only the fence characters, at most 3 spaces in */
const FENCE_CLOSER_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;

interface OpenFence {
    marker: string;
    size: number;
}

const leadingSpaces = (line: string): number => line.length - line.trimStart().length;

const opensFence = (content: string): OpenFence | null => {
    const match = content.match(FENCE_OPENER_PATTERN);
    const fence = match?.[1];
    return fence ? { marker: fence[0] ?? '`', size: fence.length } : null;
};

const closesFence = (content: string, fence: OpenFence): boolean => {
    const match = content.match(FENCE_CLOSER_PATTERN);
    const closing = match?.[1];
    return Boolean(
        closing && closing[0] === fence.marker && closing.length >= fence.size
    );
};

/**
 * Open or close list items so this marker line's nesting depth is known:
 * a line at least one step deeper than the innermost open item nests inside
 * it, a shallower one closes back out. Returns the resulting depth.
 */
const openMarkerLevel = (openIndents: number[], indent: number): number => {
    while (openIndents.length > 0) {
        const top = openIndents[openIndents.length - 1];
        if (top === undefined || indent >= top) break;
        openIndents.pop();
    }
    const top = openIndents[openIndents.length - 1];
    if (top === undefined || indent >= top + INDENT_STEP) openIndents.push(indent);
    return openIndents.length - 1;
};

export const normalizeThinkingIndent = (markdown: string): string => {
    const normalized: string[] = [];
    /** Source indents of the list items currently open, outermost first */
    const openIndents: number[] = [];
    let fence: OpenFence | null = null;

    for (const line of markdown.split('\n')) {
        const indent = leadingSpaces(line);
        const content = line.slice(indent);

        if (fence) {
            // Fenced content is literal; a closing fence is re-anchored to the
            // column the opening one was moved to
            if (closesFence(content, fence)) {
                fence = null;
                normalized.push(indent < INDENT_STEP ? line : content);
            } else {
                normalized.push(line);
            }
            continue;
        }

        // A fence deeper than a top-level block only needs re-anchoring when no
        // list item encloses it (inside one it is already legal)
        const opener =
            indent < INDENT_STEP || openIndents.length === 0 ? opensFence(content) : null;
        if (opener) {
            fence = opener;
            normalized.push(indent < INDENT_STEP ? line : content);
            continue;
        }
        if (content === '') {
            // A blank line pauses a list but does not close it
            normalized.push(line);
            continue;
        }
        if (LIST_MARKER_PATTERN.test(content)) {
            normalized.push(' '.repeat(INDENT_STEP * openMarkerLevel(openIndents, indent)) + content);
            continue;
        }
        if (indent < INDENT_STEP) {
            // Any other top-level block ends the list context
            openIndents.length = 0;
            normalized.push(line);
            continue;
        }
        if (openIndents.length > 0) {
            normalized.push(line);
            continue;
        }
        // Indented prose outside a list: it would render as a code block
        normalized.push(content);
    }

    return normalized.join('\n');
};
