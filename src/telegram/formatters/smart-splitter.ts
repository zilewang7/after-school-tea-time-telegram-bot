/**
 * Raw-text boundary splitting for the streaming continuation path — thin
 * wrapper over the package's construct-aware splitter: cuts prefer
 * paragraph/newline boundaries where no fence/<details>/table/inline
 * construct is open, and repair oversized constructs by reopening them
 * (fence line, <details><summary>…（续）, table header) in the second part.
 */
import { splitRawMarkdown, splitRawMarkdownAtNewline } from 'telegram-md-entities';

export interface SplitResult {
    currentPart: string;  // Part to send now
    remaining: string;    // Part to keep in buffer
}

/**
 * Split RAW text so that the first part still satisfies `fits` — a predicate
 * measured on the ACTUAL rendered output.
 */
export const splitRawByFits = (
    raw: string,
    fits: (prefix: string) => boolean
): SplitResult => {
    const { head, rest } = splitRawMarkdown(raw, fits);
    return { currentPart: head, remaining: rest };
};

/**
 * Cut RAW text right after its last clean paragraph break (falling back to
 * the last clean newline) at or past minPos. Used when a streaming message
 * is being closed for a continuation. currentPart is empty when no boundary
 * qualifies — callers decide whether to move everything or keep all.
 *
 * A cut inside an open fold/fence/table is not clean by definition, so the
 * clean-only search finds nothing there and the caller keeps the whole
 * buffer — finalizing mid-sentence, with the continuation re-rendered from
 * raw text that no longer carries the <details> opener (its fold is lost).
 * `repair: true` cuts at the last line break anyway and reopens the open
 * constructs in the remainder, so both halves stay folds at a line boundary.
 */
export const splitAtLastNewline = (raw: string, minPos: number = 0): SplitResult => {
    const { head, rest } = splitRawMarkdownAtNewline(raw, minPos, { repair: true });
    return { currentPart: head, remaining: rest };
};
