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

export interface RoundTextSeparator {
    /** A new round begins */
    startRound(): void;
    /** The chunk as shown; only the first visible text of a later round changes */
    apply(chunk: StreamChunk): StreamChunk;
}

export const createRoundTextSeparator = (): RoundTextSeparator => {
    let textShown = false;
    let separatorPending = false;

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
    };
};
