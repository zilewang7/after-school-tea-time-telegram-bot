/**
 * Keeps the visible text of consecutive tool rounds apart.
 *
 * Once a round has shown text, the first visible text of every later round
 * starts with a blank line, so "let me look that up" and the answer that
 * follows the tool call do not run into one paragraph. Display only: what a
 * platform replays to the provider stays verbatim.
 */
import type { StreamChunk } from '../types.js';

const ROUND_SEPARATOR = '\n\n';

/** What the separator knows, as plain data: a checkpoint keeps it, a resume restores it */
export interface RoundTextSeparatorState {
    /** Some earlier round showed visible text */
    readonly textShown: boolean;
    /** The current round's first visible text still gets the blank line */
    readonly separatorPending: boolean;
}

export interface RoundTextSeparator {
    /** A new round begins */
    startRound(): void;
    /** The chunk as shown; only the first visible text of a later round changes */
    apply(chunk: StreamChunk): StreamChunk;
    /** A copy of the current state */
    state(): RoundTextSeparatorState;
}

const FRESH_SEPARATOR: RoundTextSeparatorState = { textShown: false, separatorPending: false };

export const createRoundTextSeparator = (initial: RoundTextSeparatorState = FRESH_SEPARATOR): RoundTextSeparator => {
    let textShown = initial.textShown;
    let separatorPending = initial.separatorPending;

    return {
        startRound: () => {
            separatorPending = textShown;
        },
        apply: (chunk) => {
            // Thinking and whitespace-only text are not visible text
            if (chunk.type !== 'text' || !chunk.content?.trim()) return chunk;

            const content = separatorPending ? `${ROUND_SEPARATOR}${chunk.content}` : chunk.content;
            separatorPending = false;
            textShown = true;
            return { ...chunk, content };
        },
        state: () => ({ textShown, separatorPending }),
    };
};
