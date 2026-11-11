/**
 * How much of one reply's chain of thought the bot keeps.
 *
 * The chat message itself only shows a rolling preview; the thinking page reads
 * the full text, so this cap is what a reader of a long CoT can see. It is not
 * the model's thinking budget — the model may think past it, and the page then
 * says where it was cut. One shared constant so the live stream (panel) and the
 * stored version (reply) can never disagree about the cap or its wording.
 */
export const THINKING_MAX_CHARS = 500_000;

/** Appended once when the cap is hit; later chunks are dropped */
export const THINKING_TRUNCATION_MARK = `\n\n…（思考过程超过 ${THINKING_MAX_CHARS / 10_000} 万字，已截断）`;
