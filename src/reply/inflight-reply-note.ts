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
    `[system] another session is already replying to #${contextNumber} — do not react to #${contextNumber} again, that answer is on its way; answer only what is new.`;
