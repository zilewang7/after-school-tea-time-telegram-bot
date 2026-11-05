/**
 * Note attached to a message that another session is already answering.
 *
 * When two triggers arrive in the same context (A asks, B asks moments later in
 * the same reply tree) and the first reply is still streaming, the second
 * context contains A's message as an ordinary user turn — with nothing telling
 * the model that an answer is already on its way. The note says exactly that,
 * so the second reply does not answer A again.
 */
export const buildInFlightReplyNote = (contextNumber: number): string =>
    `[system] another session is already replying to #${contextNumber}.`;

/**
 * Note on the bot's own turn while that reply is still being written.
 *
 * A reply exists as a stored row from the moment its session starts, but its
 * text is only written at finalize. If the user replies to that message while
 * it streams (a sticker reacting to it, a follow-up question), the next context
 * includes the bot turn with no content — which used to render as
 * `[system] message lost` and made the model believe its own answer had been
 * corrupted. Say what is actually happening instead.
 */
export const buildInFlightOwnReplyNote = (contextNumber: number): string =>
    `[system] your reply #${contextNumber} is still being generated in another session; its text is not stored yet.`;

/**
 * Note on a bot turn that ended without storing any text.
 *
 * A reply can end with no text at all — the stream died before the first
 * token, the user stopped it, or the model answered with nothing. Its stored
 * row then has no content, and the same turn reads as `[system] message lost`,
 * which makes the model believe its own answer was corrupted. Say what
 * happened, and that a retry exists.
 */
export const buildInterruptedOwnReplyNote = (contextNumber: number): string =>
    `[system] your reply #${contextNumber} ended without producing any text (interrupted or empty); nothing of it was stored, and the user can retry it.`;
