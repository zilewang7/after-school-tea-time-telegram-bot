/**
 * Best-effort writes of the reply delivery ledger from the delivery code.
 *
 * The delivery path must never lose a message (or a reply) because bookkeeping
 * failed: every helper here catches and only warns. Callers run them right after
 * a message exists in the chat, so a reaction arriving in the gap before
 * finalize can still be normalized to its reply and part.
 */
import {
    appendBodyPart,
    lookupReplyPart,
    removeReplyPart,
    setReplyPart,
    type ReplyPartLookup,
} from '../db/queries/reply-part-queries.js';
import type { ReplyPartKind } from '../shared/reply-part.js';

const warn = (operation: string, chatId: number, messageId: number, error: unknown): void => {
    console.warn(
        `[reply-part] ${operation} failed for ${chatId}/${messageId}:`,
        error instanceof Error ? error.message : error
    );
};

/** Record one delivered message as a part of its reply */
export const registerReplyPart = async (input: {
    readonly chatId: number;
    readonly canonicalMessageId: number;
    readonly messageId: number;
    readonly part: ReplyPartKind;
    readonly partIndex?: number | null;
}): Promise<void> => {
    try {
        await setReplyPart(input);
    } catch (error) {
        warn('register', input.chatId, input.messageId, error);
    }
};

/** Record a streamed body message; its segment number continues the reply's own */
export const registerBodyReplyPart = async (
    chatId: number,
    canonicalMessageId: number,
    messageId: number
): Promise<void> => {
    try {
        await appendBodyPart(chatId, canonicalMessageId, messageId);
    } catch (error) {
        warn('append body', chatId, messageId, error);
    }
};

/** Forget a message the layout actually deleted from the chat */
export const forgetReplyPart = async (chatId: number, messageId: number): Promise<void> => {
    try {
        await removeReplyPart(chatId, messageId);
    } catch (error) {
        warn('remove', chatId, messageId, error);
    }
};

/** The ledger lookup as the model-side tool needs it; errors are the caller's */
export const findReplyPart = lookupReplyPart;

export type { ReplyPartLookup };
