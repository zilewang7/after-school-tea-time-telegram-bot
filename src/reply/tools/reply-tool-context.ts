/**
 * What a reply-layer tool knows about the turn it serves.
 */
import type { Chat } from 'grammy/types';
import type { ContextIndex } from '../context-index.js';

export interface ToolRequester {
    /** Null on rows stored before author ids were recorded */
    readonly userId: number | null;
    readonly name: string;
}

export interface ReplyToolContext {
    readonly chatId: number;
    /** Group title; undefined in private chats */
    readonly chatTitle: string | undefined;
    /** The user message this reply answers */
    readonly triggerMessageId: number;
    /** Author of the trigger message — never whoever pressed retry */
    readonly requester: ToolRequester;
    /** `#N` → message of this turn's context */
    readonly contextIndex: ContextIndex;
    /** Aborts when the reply is stopped */
    readonly signal: AbortSignal;
}

/** The stored row of the trigger message, as far as tools care */
export interface TriggerMessageRow {
    readonly messageId: number;
    readonly userId: number | null;
    readonly userName: string;
}

export const buildReplyToolContext = (input: {
    readonly chat: Chat;
    readonly triggerMessage: TriggerMessageRow;
    readonly contextIndex: ContextIndex;
    readonly signal: AbortSignal;
}): ReplyToolContext => ({
    chatId: input.chat.id,
    chatTitle: input.chat.type === 'private' ? undefined : input.chat.title,
    triggerMessageId: input.triggerMessage.messageId,
    requester: {
        userId: input.triggerMessage.userId,
        name: input.triggerMessage.userName,
    },
    contextIndex: input.contextIndex,
    signal: input.signal,
});
