/**
 * Lay a final layout (one rendered chunk per message) over the messages a reply
 * already has in the chat: edit them in order, send the chunks the chat lacks,
 * delete the ones the layout no longer needs.
 *
 * The final delivery and the stored-version refresh share this, so the layout a
 * live reply ends with and the one a replay produces stay identical (both are
 * rendered by `buildFinalMessages`).
 */
import type { Api, RawApi } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { to } from '../shared/result.js';
import { registerContinuation } from '../state.js';
import { toApiEntities } from './api-entities.js';
import { runApiCall, submitEdit } from './edit-coordinator.js';
import type { FinalMessageChunk } from './formatters/final-message-builder.js';

export interface LayOutChunksInput {
    readonly api: Api<RawApi>;
    readonly chatId: number;
    /** The user message the reply answers; a sent chunk replies to it as well */
    readonly userMessageId: number;
    /** The reply's first message id, for the continuation registry */
    readonly firstMessageId: number;
    /** Existing text message ids in chat order (media messages excluded) */
    readonly messageIds: readonly number[];
    /** The final layout, one chunk per message; must not be empty */
    readonly chunks: readonly FinalMessageChunk[];
    /** Buttons for the last chunk (the caller adds them to a media message itself) */
    readonly replyMarkup?: InlineKeyboardMarkup;
}

export interface LayOutChunksResult {
    /** Text message ids after the layout, in chat order */
    readonly messageIds: number[];
    /** The reply's last text message */
    readonly currentMessageId: number;
    /** Every edit, send and delete went through */
    readonly allDelivered: boolean;
}

/**
 * Write the layout over the chat. Editing an earlier message is deliberate: the
 * final layout is computed from the complete reply, while the messages the
 * stream left behind were built from partial buffers.
 */
export const layOutChunks = async (input: LayOutChunksInput): Promise<LayOutChunksResult> => {
    const { api, chatId, userMessageId, firstMessageId, chunks } = input;
    const messageIds = [...input.messageIds];
    // An empty layout would delete the whole reply; callers guarantee one chunk
    if (chunks.length === 0) {
        return {
            messageIds,
            currentMessageId: messageIds[messageIds.length - 1] ?? firstMessageId,
            allDelivered: false,
        };
    }
    let allDelivered = true;

    const editable = Math.min(chunks.length, messageIds.length);
    for (let index = 0; index < editable; index += 1) {
        const messageId = messageIds[index];
        const chunk = chunks[index];
        if (messageId === undefined || chunk === undefined) continue;
        const carriesButtons = index === chunks.length - 1;
        const delivered = await submitEdit(api, chatId, messageId, chunk.text, {
            entities: chunk.entities,
            replyMarkup: carriesButtons ? input.replyMarkup : undefined,
            linkPreviewOptions: chunk.linkPreviewOptions,
            isFinal: true,
        });
        if (!delivered) allDelivered = false;
    }

    // The layout needs more messages than the chat has (the stream ended before
    // the last continuation existed, or the layout grew while finalizing)
    for (let index = messageIds.length; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (chunk === undefined) continue;
        const carriesButtons = index === chunks.length - 1;
        const [sendError, sent] = await to(
            runApiCall(chatId, () =>
                api.sendMessage(chatId, chunk.text, {
                    entities: toApiEntities(chunk.entities),
                    reply_parameters: { message_id: userMessageId },
                    reply_markup: carriesButtons ? input.replyMarkup : undefined,
                    link_preview_options: chunk.linkPreviewOptions,
                })
            )
        );
        if (sendError !== null) {
            console.error('[final-layout] failed to send an overflow chunk:', sendError);
            allDelivered = false;
            break;
        }
        messageIds.push(sent.message_id);
        registerContinuation(chatId, sent.message_id, firstMessageId);
    }

    // The layout needs fewer messages than the chat has: the reply must not keep
    // text its final layout no longer contains (the streaming split is finer
    // than the final budget, so two streamed messages can merge into one)
    while (messageIds.length > chunks.length) {
        const messageId = messageIds[messageIds.length - 1];
        if (messageId === undefined) break;
        const [deleteError] = await to(
            runApiCall(chatId, () => api.deleteMessage(chatId, messageId))
        );
        if (deleteError !== null) {
            console.error('[final-layout] failed to delete a surplus message:', deleteError);
            allDelivered = false;
            break;
        }
        messageIds.pop();
    }

    return {
        messageIds,
        currentMessageId: messageIds[messageIds.length - 1] ?? firstMessageId,
        allDelivered,
    };
};
