/**
 * Where a rich error display cuts an answer it cannot show whole. A plain
 * search on purpose: the construct-aware raw splitter is quadratic on tables
 * and code blocks, and the answer's rich markdown closes the blocks a cut
 * leaves open. A cut that turns a '#N' into a link the whole answer does not
 * have is caught after rendering (rich-reply-body.ts).
 */

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** A `#N` right before a cut */
const REFERENCE_BEFORE_CUT = /#\d{1,3}$/;

/**
 * A cut inside `#12` would leave `#1`, a link to another message, and one
 * between the `#1` and the `a` of `#1a` (no reference) would make a
 * reference of the `#1`: cut before the `#`
 */
const outsideReference = (text: string, end: number): number => {
    const reference = REFERENCE_BEFORE_CUT.exec(text.slice(Math.max(0, end - 4), end));
    return reference !== null && /[\w-]/.test(text[end] ?? '') ? end - reference[0].length : end;
};

/**
 * Where the head of text ends when it may be at most target long: the last
 * paragraph boundary, else the last line break, else target itself (never
 * between the halves of a surrogate pair or inside a `#N`). A boundary in
 * the first half is passed over: it would drop most of what is left.
 */
export const headEndOf = (text: string, target: number): number => {
    const floor = Math.floor(target / 2);
    const paragraphEnd = text.lastIndexOf('\n\n', target);
    if (paragraphEnd > floor) return paragraphEnd;
    const lineEnd = text.lastIndexOf('\n', target);
    if (lineEnd > floor) return lineEnd;
    return outsideReference(text, isHighSurrogate(text.charCodeAt(target - 1)) ? target - 1 : target);
};
