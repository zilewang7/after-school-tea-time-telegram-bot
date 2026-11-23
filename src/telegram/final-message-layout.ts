/**
 * Lay a final layout (one rendered chunk per message) over the messages a reply
 * already has in the chat: edit them in order, send the chunks the chat lacks,
 * delete the ones the layout no longer needs.
 *
 * The final delivery and the stored-version refresh share this, so the layout a
 * live reply ends with and the one a replay produces stay identical (both are
 * rendered by `buildFinalMessages`).
 *
 * A chunk is either rendered text with entities or a rich message's markdown
 * (a reply delivered as a rich message); the two kinds mix in one layout.
 *
 * The layout is also where the reply's delivery ledger learns what each message
 * it delivered is: after every edit, send and delete that went through, the
 * optional callbacks run. The telegram layer does not write the ledger itself
 * (it has no db dependency); the caller books the message under its reply.
 */
import { GrammyError, type Api, type RawApi } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import type { ReplyPartKind } from '../shared/reply-part.js';
import { to } from '../shared/result.js';
import { registerContinuation, unregisterBotReplyInFlight, unregisterContinuation } from '../state.js';
import { toApiEntities } from './api-entities.js';
import { runApiCall, submitEdit } from './edit-coordinator.js';
import type { FinalMessageChunk } from './formatters/final-message-builder.js';
import {
    richMediaBytesOf,
    richMediaFieldOf,
    type RichMediaPayload,
} from './formatters/rich-inline-media/payload.js';

export type { RichMediaPayload } from './formatters/rich-inline-media/payload.js';
export { richMediaPayloadOf } from './formatters/rich-inline-media/payload.js';

/** One message of the layout sent as a rich message: its whole markdown */
export interface RichLayoutChunk {
    readonly richMarkdown: string;
    /**
     * The pictures the markdown embeds, uploaded with the same call. Absent (or
     * empty) when the body has none: the request must then stay exactly the
     * one a body without pictures sends.
     */
    readonly richMedia?: readonly RichMediaPayload[];
    /**
     * Which part of the reply the message is. Absent means body text: a rich
     * body is always the reply's text, so the layouts never set it today; the
     * field keeps a rich layout chunk able to name another part in the future.
     */
    readonly part?: ReplyPartKind;
}

export type LayoutChunk = FinalMessageChunk | RichLayoutChunk;

export const isRichLayoutChunk = (chunk: LayoutChunk): chunk is RichLayoutChunk => 'richMarkdown' in chunk;

/** Which part of a reply a layout chunk delivers, with its segment number */
export interface ReplyChunkPart {
    readonly part: ReplyPartKind;
    /** 1-based body segment number (pictures use their own counter); null otherwise */
    readonly partIndex: number | null;
}

/** One delivered layout message: what it is, for the caller's delivery ledger */
export interface DeliveredChunk extends ReplyChunkPart {
    readonly messageId: number;
    /** Index of the chunk in the layout */
    readonly chunkIndex: number;
}

/**
 * The part each chunk of a layout is, in layout order. A chunk built as a
 * dedicated message names its kind (`toThinkingLinkChunk` and the two folded
 * blocks); everything else is body text and is numbered here — consecutive body
 * chunks are segments 1..N of the reply's text, exactly as the chat shows them.
 *
 * Callers delivering a layout by hand (a version switch, the merge fallback)
 * use the same numbering, so the ledger reads the same whichever path wrote it.
 */
export const chunkPartsOf = (chunks: readonly LayoutChunk[]): ReplyChunkPart[] => {
    let bodyIndex = 0;
    return chunks.map((chunk): ReplyChunkPart => {
        const part: ReplyPartKind = chunk.part ?? 'body';
        if (part !== 'body') return { part, partIndex: null };
        bodyIndex += 1;
        return { part, partIndex: bodyIndex };
    });
};

/** A bookkeeping callback never breaks the delivery it reports on */
const runLedgerCallback = async (
    description: string,
    callback: () => void | Promise<void>
): Promise<void> => {
    try {
        await callback();
    } catch (error) {
        console.warn(`[final-layout] ${description} failed:`, error);
    }
};

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
    readonly chunks: readonly LayoutChunk[];
    /** Buttons for the last chunk (the caller adds them to a media message itself) */
    readonly replyMarkup?: InlineKeyboardMarkup;
    /** Telegram refused a rich chunk (its edit or its send) */
    readonly onRichRejected?: (error: GrammyError) => void;
    /**
     * Telegram answered a rich edit or send with the message: the caller can
     * check the delivered blocks (a caption that breaks a media block line
     * loses a picture without an error).
     */
    readonly onRichDelivered?: (message: Message) => void;
    /**
     * An edit or a send went through: the message id and the part it now is.
     * The caller books it in the reply's delivery ledger, best-effort; a throw
     * from it is logged and never stops the layout.
     */
    readonly onChunkDelivered?: (delivery: DeliveredChunk) => void | Promise<void>;
    /** A surplus message was actually deleted from the chat: forget it */
    readonly onMessageDeleted?: (messageId: number) => void | Promise<void>;
}

export interface LayOutChunksResult {
    /** Text message ids after the layout, in chat order */
    readonly messageIds: number[];
    /** The reply's last text message */
    readonly currentMessageId: number;
    /** Every edit, send and delete went through */
    readonly allDelivered: boolean;
    /**
     * Every rich chunk of the layout is in the chat (edited or sent); one that
     * was never tried because an earlier send failed counts as not delivered.
     * Vacuously true for a layout without rich chunks.
     */
    readonly richDelivered: boolean;
}

/**
 * Write the layout over the chat. Editing an earlier message is deliberate: the
 * final layout is computed from the complete reply, while the messages the
 * stream left behind were built from partial buffers.
 */
export const layOutChunks = async (input: LayOutChunksInput): Promise<LayOutChunksResult> => {
    const { api, chatId, userMessageId, firstMessageId, chunks } = input;
    const messageIds = [...input.messageIds];
    const richChunkCount = chunks.filter(isRichLayoutChunk).length;
    const chunkParts = chunkPartsOf(chunks);
    // The ledger callbacks: each delivered/deleted message tells the caller what
    // it is; booking a message is best-effort and never stops the layout
    const notifyDelivered = async (messageId: number, chunkIndex: number): Promise<void> => {
        const callback = input.onChunkDelivered;
        const chunkPart = chunkParts[chunkIndex];
        if (callback === undefined || chunkPart === undefined) return;
        await runLedgerCallback('onChunkDelivered', () =>
            callback({ messageId, chunkIndex, part: chunkPart.part, partIndex: chunkPart.partIndex })
        );
    };
    const notifyDeleted = async (messageId: number): Promise<void> => {
        const callback = input.onMessageDeleted;
        if (callback === undefined) return;
        await runLedgerCallback('onMessageDeleted', () => callback(messageId));
    };
    // An empty layout would delete the whole reply; callers guarantee one chunk
    if (chunks.length === 0) {
        return {
            messageIds,
            currentMessageId: messageIds[messageIds.length - 1] ?? firstMessageId,
            allDelivered: false,
            richDelivered: true,
        };
    }
    let allDelivered = true;
    let richChunksDelivered = 0;

    const editable = Math.min(chunks.length, messageIds.length);
    for (let index = 0; index < editable; index += 1) {
        const messageId = messageIds[index];
        const chunk = chunks[index];
        if (messageId === undefined || chunk === undefined) continue;
        const carriesButtons = index === chunks.length - 1;
        const delivered = isRichLayoutChunk(chunk)
            ? await submitEdit(api, chatId, messageId, chunk.richMarkdown, {
                  replyMarkup: carriesButtons ? input.replyMarkup : undefined,
                  isFinal: true,
                  rich: {
                      onRejected: input.onRichRejected,
                      ...(chunk.richMedia === undefined ? {} : { media: chunk.richMedia }),
                      ...(input.onRichDelivered === undefined ? {} : { onDelivered: input.onRichDelivered }),
                  },
              })
            : await submitEdit(api, chatId, messageId, chunk.text, {
                  entities: chunk.entities,
                  replyMarkup: carriesButtons ? input.replyMarkup : undefined,
                  linkPreviewOptions: chunk.linkPreviewOptions,
                  isFinal: true,
              });
        if (!delivered) allDelivered = false;
        else {
            if (isRichLayoutChunk(chunk)) richChunksDelivered += 1;
            await notifyDelivered(messageId, index);
        }
    }

    // The layout needs more messages than the chat has (the stream ended before
    // the last continuation existed, or the layout grew while finalizing)
    for (let index = messageIds.length; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (chunk === undefined) continue;
        const carriesButtons = index === chunks.length - 1;
        const [sendError, sent] = await to(
            runApiCall<Message>(chatId, () =>
                isRichLayoutChunk(chunk)
                    ? api.sendRichMessage(
                          chatId,
                          { markdown: chunk.richMarkdown, ...richMediaFieldOf(chunk.richMedia) },
                          {
                              reply_parameters: { message_id: userMessageId },
                              reply_markup: carriesButtons ? input.replyMarkup : undefined,
                          }
                      )
                    : api.sendMessage(chatId, chunk.text, {
                          entities: toApiEntities(chunk.entities),
                          reply_parameters: { message_id: userMessageId },
                          reply_markup: carriesButtons ? input.replyMarkup : undefined,
                          link_preview_options: chunk.linkPreviewOptions,
                      })
            )
        );
        if (sendError !== null) {
            console.error('[final-layout] failed to send an overflow chunk:', sendError);
            // A 429 that escaped the retries is pacing, not a refusal of the content
            if (isRichLayoutChunk(chunk) && sendError instanceof GrammyError && sendError.error_code !== 429) {
                input.onRichRejected?.(sendError);
            }
            allDelivered = false;
            break;
        }
        if (isRichLayoutChunk(chunk)) {
            if (chunk.richMedia !== undefined && chunk.richMedia.length > 0) {
                console.log(
                    `[rich-inline] media payload chat=${chatId} pictures=${chunk.richMedia.length} bytes=${richMediaBytesOf(chunk.richMedia)} sent`
                );
            }
            input.onRichDelivered?.(sent);
        }
        messageIds.push(sent.message_id);
        registerContinuation(chatId, sent.message_id, firstMessageId);
        if (isRichLayoutChunk(chunk)) richChunksDelivered += 1;
        await notifyDelivered(sent.message_id, index);
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
        // The message is gone, and the reply's finalization only knows the
        // messages that are left: nothing of this one stays registered
        unregisterContinuation(chatId, messageId);
        unregisterBotReplyInFlight(chatId, messageId);
        await notifyDeleted(messageId);
    }

    return {
        messageIds,
        currentMessageId: messageIds[messageIds.length - 1] ?? firstMessageId,
        allDelivered,
        richDelivered: richChunksDelivered === richChunkCount,
    };
};
