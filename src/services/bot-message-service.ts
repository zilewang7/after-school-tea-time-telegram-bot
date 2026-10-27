/**
 * Bot Message Service
 * Manages bot message lifecycle including streaming, stop, retry, and version switching
 */
import type { Api, Context } from 'grammy';
import { match } from 'ts-pattern';
import {
    ButtonState,
    createBotResponse,
    getBotResponse,
    findBotResponseByMessageId,
    findProcessingResponses,
    writeBotMessageRow,
    type ResponseVersion,
    type ResponseMetadata,
    type StoredSticker,
    type CommandType,
} from '../db/index.js';
import {
    createMessageEditor,
    type MessageEditor,
} from '../telegram/index.js';
import { buildFinalMessages, type FinalMessageChunk } from '../telegram/formatters/final-message-builder.js';
import { buildMessageLinkResolver } from '../telegram/message-link.js';
import { plainText } from '../telegram/formatters/entity-text.js';
import { appendErrorLine } from '../telegram/formatters/error-display.js';
import { formatErrorForUser } from '../shared/errors.js';
import { stripContextLabel } from '../reply/context-label.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { buildResponseButtons } from '../cmd/menus/index.js';
import { to, isErr, type Result } from '../shared/result.js';
import {
    getCurrentModel,
    registerBotReplyInFlight,
    registerContinuation,
    registerReplyInFlight,
    unregisterBotReplyInFlight,
    unregisterContinuation,
    unregisterReplyInFlight,
} from '../state.js';
import { runApiCall, submitEdit } from '../telegram/edit-coordinator.js';
import { decideFinalButtonState } from './final-button-state.js';
import { sniffMediaMime } from '../ai/image-generation/image-mime.js';
import { buildImageCaption } from '../reply/tools/image-message.js';
import { sendReplyImageMessage } from '../telegram/reply-image-send.js';
import type { ContextLinkResolver } from '../telegram/formatters/context-links.js';
import type { AgentStats, StickerDelivery } from '../ai/types.js';

/**
 * Stream controller for aborting streams
 */
export interface StreamController {
    /** Abort the stream */
    abort: () => void;
    /** Check if aborted */
    isAborted: () => boolean;
    /** Get abort signal for async operations */
    signal: AbortSignal;
}

/**
 * Create a stream controller
 */
export const createStreamController = (): StreamController => {
    const abortController = new AbortController();
    return {
        abort: () => abortController.abort(),
        isAborted: () => abortController.signal.aborted,
        signal: abortController.signal,
    };
};

/**
 * Response content for sending
 */
export interface ResponseContent {
    text: string;
    thinkingText?: string;
    groundingData?: any[];
    agentStats?: AgentStats;
    images?: Buffer[];
    errorMessage?: string;
    modelParts?: any;
}

/**
 * Finalize options
 */
export interface FinalizeOptions {
    modelParts?: any;
    wasStoppedByUser?: boolean;
    errorMessage?: string;
    /** Caption the reply's image went out with */
    imageCaption?: string;
}

/**
 * Bot message session - represents an active bot response
 */
export interface BotMessageSession {
    // Identifiers
    chatId: number;
    userMessageId: number;
    firstMessageId: number;

    // Message management
    messageIds: number[];
    currentMessageId: number;
    editor: MessageEditor;

    // Content buffers
    textBuffer: string;
    thinkingBuffer: string;
    images: Buffer[];
    /** The sticker this reply sent, when it chose one instead of an image */
    sticker?: StickerDelivery;
    /** The sticker's webp for storage and the next context; absent if download failed */
    stickerBytes?: Buffer;
    groundingData: any[];
    agentStats?: AgentStats;

    // Stream control
    streamController: StreamController;

    // Version info
    isRetry: boolean;
    versionCount: number;
    isFinalized: boolean;

    // Context
    api: Api;

    // Operations
    appendText: (text: string) => void;
    appendThinking: (text: string) => void;
    addImage: (image: Buffer) => void;
    addGrounding: (data: any) => void;
    createContinuationMessage: () => Promise<MessageEditor | null>;
    finalize: (options?: FinalizeOptions) => Promise<void>;
    handleError: (error: Error) => Promise<void>;
    stop: () => Promise<void>;
    updateButtons: (state: ButtonState) => Promise<void>;
}

/**
 * Session creation options
 */
export interface CreateSessionOptions {
    isRetry?: boolean;
    existingFirstMessageId?: number;
    /** DB anchor ID — the BotResponse primary key. When set, session.firstMessageId uses this
     *  but a NEW processing message is sent instead of editing the existing one. */
    dbAnchorMessageId?: number;
    /** Command type for retry routing */
    commandType?: CommandType;
}

/**
 * Active sessions map
 */
const activeSessions = new Map<string, BotMessageSession>();

/**
 * Get session key
 */
const getSessionKey = (chatId: number, messageId: number): string => {
    return `${chatId}:${messageId}`;
};

/**
 * Get an active session
 */
export const getActiveSession = (chatId: number, firstMessageId: number): BotMessageSession | null => {
    const key = getSessionKey(chatId, firstMessageId);
    return activeSessions.get(key) ?? null;
};

/**
 * Create a new bot message session
 */
export const createSession = async (
    ctx: Context,
    userMessageId: number,
    options?: CreateSessionOptions
): Promise<BotMessageSession | null> => {
    if (!ctx.chat) return null;

    const chatId = ctx.chat.id;
    const api = ctx.api;

    // For retry, we reuse the existing first message
    let firstMessageId = options?.dbAnchorMessageId ?? options?.existingFirstMessageId;
    let processingMsgId: number;

    // Initial status text (matches first entry in streaming-editor statusData)
    const initialStatus = '✽ Thinking...';

    // Build stop button for processing state
    const stopButton = buildResponseButtons(ButtonState.PROCESSING);

    if (options?.isRetry && options.existingFirstMessageId) {
        // Edit existing first message with stop button
        processingMsgId = options.existingFirstMessageId;
        const editor = createMessageEditor(api, chatId, processingMsgId);
        await editor.edit(initialStatus, {
            replyMarkup: stopButton,
        });
    } else {
        // Send new processing message with stop button
        const sendResult = await to(
            ctx.reply(initialStatus, {
                reply_parameters: { message_id: userMessageId },
                reply_markup: stopButton,
            })
        );

        if (isErr(sendResult)) {
            console.error('[bot-message-service] Failed to create processing message:', sendResult[0]);
            return null;
        }

        processingMsgId = sendResult[1].message_id;
        if (!firstMessageId) {
            firstMessageId = processingMsgId;
        }
    }

    const streamController = createStreamController();
    const editor = createMessageEditor(api, chatId, processingMsgId);

    // Get existing version count if retry
    let versionCount = 0;
    const dbLookupId = options?.dbAnchorMessageId ?? options?.existingFirstMessageId;
    if (options?.isRetry && dbLookupId) {
        const existing = await getBotResponse(chatId, dbLookupId);
        if (existing) {
            versionCount = existing.getVersions().length;
        }
    }

    // At this point firstMessageId is always set (either from options or new message)
    const resolvedFirstMessageId = firstMessageId ?? processingMsgId;

    // Create session object
    const session: BotMessageSession = {
        chatId,
        userMessageId,
        firstMessageId: resolvedFirstMessageId,
        messageIds: [processingMsgId],
        currentMessageId: processingMsgId,
        editor,
        textBuffer: '',
        thinkingBuffer: '',
        images: [],
        groundingData: [],
        agentStats: undefined,
        streamController,
        isRetry: options?.isRetry ?? false,
        versionCount,
        isFinalized: false,
        api,

        appendText: (text: string) => {
            session.textBuffer += text;
        },
        appendThinking: (text: string) => {
            session.thinkingBuffer += text;
        },
        addImage: (image: Buffer) => {
            session.images.push(image);
        },
        addGrounding: (data: any) => {
            session.groundingData.push(data);
        },

        createContinuationMessage: async () => {
            return createContinuation(session);
        },
        finalize: async (opts?: FinalizeOptions) => {
            return finalizeSession(session, opts);
        },
        handleError: async (error: Error) => {
            return handleSessionError(session, error);
        },
        stop: async () => {
            return stopSession(session);
        },
        updateButtons: async (state: ButtonState) => {
            return updateSessionButtons(session, state);
        },
    };

    // Store in active sessions
    const sessionKey = getSessionKey(chatId, resolvedFirstMessageId);
    activeSessions.set(sessionKey, session);

    // Another trigger may assemble its context while this reply streams: mark
    // both the user message as answered and the reply itself as still being
    // written, so a context that includes either can say so (see context-builder)
    registerReplyInFlight(chatId, userMessageId);
    registerBotReplyInFlight(chatId, resolvedFirstMessageId);

    // Initialize database record for new response (not retry)
    if (!options?.isRetry) {
        const metadata: ResponseMetadata = {
            model: getCurrentModel(),
            hasImage: false,
            commandType: options?.commandType,
        };
        await createBotResponse(chatId, resolvedFirstMessageId, userMessageId, metadata);
    } else {
        // Update button state to processing for retry
        const response = await getBotResponse(chatId, resolvedFirstMessageId);
        if (response) {
            response.buttonState = ButtonState.PROCESSING;
            await response.save();
        }
    }

    return session;
};

/**
 * Create continuation message for long responses
 */
const createContinuation = async (session: BotMessageSession): Promise<MessageEditor | null> => {
    const sendResult = await to(
        runApiCall(session.chatId, () =>
            session.api.sendMessage(session.chatId, 'continued', {
                reply_parameters: { message_id: session.userMessageId },
            })
        )
    );

    if (isErr(sendResult)) {
        console.error('[bot-message-service] Failed to create continuation:', sendResult[0]);
        return null;
    }

    const newMessageId = sendResult[1].message_id;
    session.messageIds.push(newMessageId);
    session.currentMessageId = newMessageId;
    session.editor = createMessageEditor(session.api, session.chatId, newMessageId);

    registerContinuation(session.chatId, newMessageId, session.firstMessageId);
    // A reply can target this chunk, not just the first message
    registerBotReplyInFlight(session.chatId, newMessageId);

    return session.editor;
};

/**
 * The bot's turn as later contexts read it: the reply text, the [stopped]
 * marker, then the image caption, in the order the chat shows them. null when
 * an image says it all.
 */
const botRowTextOf = (reply: {
    readonly text: string;
    readonly wasStoppedByUser: boolean;
    readonly hasImage: boolean;
    readonly imageCaption: string | undefined;
}): string | null => {
    const parts = [
        reply.text,
        reply.wasStoppedByUser ? '[stopped]' : '',
        reply.hasImage ? reply.imageCaption ?? '' : '',
    ].filter((part) => part.length > 0);

    if (parts.length > 0) return parts.join('\n\n');
    return reply.hasImage ? null : '[Empty response]';
};

/**
 * Finalize session - save to database and cleanup
 */
const finalizeSession = async (
    session: BotMessageSession,
    options?: FinalizeOptions
): Promise<void> => {
    // Prevent double finalization
    if (session.isFinalized) {
        console.log('[bot-message-service] Session already finalized, skipping');
        return;
    }
    session.isFinalized = true;

    const sessionKey = getSessionKey(session.chatId, session.firstMessageId);

    // Last line of defense before the reply is versioned and stored: text that
    // never went through the stream processor (image-chat turns and the like)
    // loses its imitated `[#N]` labels here as well
    session.textBuffer = stripContextLabel(session.textBuffer);

    const image = session.images[0];
    const sticker = session.sticker;
    // The bytes stored with the version: an image, or the sticker's webp
    const mediaBuffer = sticker ? session.stickerBytes : image;
    // Only the delivered (first) image has a caption; stickers have none
    const imageCaption = image && options?.imageCaption ? options.imageCaption : undefined;

    // Build version data
    const version: ResponseVersion = {
        versionId: session.versionCount + 1,
        createdAt: new Date().toISOString(),
        messageIds: [...session.messageIds],
        currentMessageId: session.currentMessageId,
        text: session.textBuffer,
        thinkingText: session.thinkingBuffer || undefined,
        groundingData: session.groundingData.length ? session.groundingData : undefined,
        agentStats: session.agentStats,
        errorMessage: options?.errorMessage,
        modelParts: options?.modelParts,
        wasStoppedByUser: options?.wasStoppedByUser ?? false,
        imageBase64: mediaBuffer?.toString('base64'),
        imageCaption: sticker ? undefined : imageCaption,
        ...(sticker === undefined
            ? {}
            : {
                  sticker: {
                      packIndex: sticker.packIndex,
                      label: sticker.label,
                      emoji: sticker.emoji,
                      fileId: sticker.fileId,
                      fileUniqueId: sticker.fileUniqueId,
                  } satisfies StoredSticker,
              }),
    };

    // Update BotResponse database
    const response = await getBotResponse(session.chatId, session.firstMessageId);
    if (response) {
        response.addVersion(version);

        // Determine button state; a user edit that arrived while we were
        // still generating means the retry offer should ship with the final
        // edit itself (adding it afterwards would race the final edit)
        const { consumePendingEditWhileProcessing } = await import('../state.js');
        const editedWhileProcessing = consumePendingEditWhileProcessing(
            session.chatId,
            session.userMessageId
        );
        response.buttonState = decideFinalButtonState({
            versions: response.getVersions(),
            hasError: Boolean(options?.wasStoppedByUser || options?.errorMessage),
            editedWhileProcessing,
        });

        // Update metadata if the reply carries a visual attachment
        if (session.images.length > 0 || sticker !== undefined) {
            const metadata = response.getMetadata();
            metadata.hasImage = true;
            if (sticker !== undefined) metadata.hasSticker = true;
            response.setMetadata(metadata);
        }

        await response.save();
    }

    // Also save to Message table for context building: the bot's reply is
    // ONE row with text + its first image, overwritten whole so nothing of an
    // earlier version survives in it
    await writeBotMessageRow({
        chatId: session.chatId,
        messageId: session.firstMessageId,
        replyToId: session.userMessageId,
        date: new Date(),
        text: botRowTextOf({
            text: session.textBuffer,
            wasStoppedByUser: options?.wasStoppedByUser ?? false,
            hasImage: mediaBuffer !== undefined,
            imageCaption: sticker === undefined ? imageCaption : undefined,
        }),
        modelParts: options?.modelParts ?? null,
        file: mediaBuffer ?? null,
        fileMime: mediaBuffer ? sniffMediaMime(mediaBuffer) : null,
        ...(sticker === undefined ? {} : { mediaHint: 'sticker' }),
    });

    // Remove from active sessions; the reply now has stored content, so it is no
    // longer "still being written" for contexts assembled later
    activeSessions.delete(sessionKey);
    unregisterReplyInFlight(session.chatId, session.userMessageId);

    for (const msgId of session.messageIds) {
        unregisterBotReplyInFlight(session.chatId, msgId);
        if (msgId !== session.firstMessageId) {
            unregisterContinuation(session.chatId, msgId);
        }
    }
};

/**
 * Handle session error — persistence only. The partial text is saved as the
 * version/message content and the error string goes into the separate
 * version.errorMessage field. The visible "partial + error line" edit is
 * owned by response-handler's handleResponseError (single owner: avoids the
 * old double-edit where two different messages got conflicting error text).
 */
const handleSessionError = async (session: BotMessageSession, error: Error): Promise<void> => {
    console.error('[bot-message-service] Session error:', error);

    await finalizeSession(session, {
        errorMessage: error.message,
    });
};

/**
 * Stop session - abort stream only, let normal flow handle finalization
 * The normal processStream flow will detect abort and handle [stopped] marker and buttons
 */
const stopSession = async (session: BotMessageSession): Promise<void> => {
    // Just abort the stream - normal flow will handle the rest
    session.streamController.abort();
};

/**
 * Update session buttons
 */
const updateSessionButtons = async (session: BotMessageSession, state: ButtonState): Promise<void> => {
    // Update database
    const response = await getBotResponse(session.chatId, session.firstMessageId);
    if (response) {
        response.buttonState = state;
        await response.save();
    }

    // Note: Actual button update on message is handled by the menu system
};

/**
 * Stop an active response
 */
export const stopResponse = async (chatId: number, firstMessageId: number): Promise<boolean> => {
    const session = getActiveSession(chatId, firstMessageId);
    if (!session) return false;

    await session.stop();
    return true;
};

/**
 * A restart kills the stream it was in the middle of: the reply keeps a stop
 * button no session answers any more, and a retry finds no stored version.
 * Nothing can be streaming while starting up, so every row still marked as
 * processing is stale. Make them retryable and take the stop button off their
 * message, so the chat shows what the bot can actually do with them.
 */
export const reconcileInterruptedResponses = async (api: Api): Promise<number> => {
    const [findErr, found] = await to(findProcessingResponses());
    if (findErr || !found) {
        console.error('[bot-message-service] Failed to list interrupted responses:', findErr);
        return 0;
    }

    for (const response of found) {
        response.buttonState = ButtonState.RETRY_ONLY;
        const [saveErr] = await to(response.save());
        if (saveErr) {
            console.error('[bot-message-service] Failed to mark response retryable:', response.messageId, saveErr);
            continue;
        }

        const [editErr] = await to(
            runApiCall(response.chatId, () =>
                api.editMessageReplyMarkup(response.chatId, response.messageId, {
                    reply_markup: buildResponseButtons(ButtonState.RETRY_ONLY),
                })
            )
        );
        // A deleted message is already clean; anything else is worth a look
        if (editErr && !/message is not modified|message to edit not found/i.test(editErr.message)) {
            console.warn('[bot-message-service] Interrupted message keeps its buttons:', response.messageId, editErr.message);
        }
    }

    if (found.length > 0) {
        console.log(`[bot-message-service] ${found.length} interrupted response(s) made retryable`);
    }
    return found.length;
};

/**
 * The messages a stored version shows: the final layout of its text,
 * thinking and records, plus an errored version's error line (display-only,
 * never stored)
 */
const buildVersionMessages = (
    version: ResponseVersion,
    resolveContextLink?: ContextLinkResolver
): FinalMessageChunk[] => {
    const chunks = buildFinalMessages({
        text: version.text || '',
        thinking: version.thinkingText,
        agentStats: version.agentStats,
        groundingData: version.groundingData,
        wasStoppedByUser: version.wasStoppedByUser,
        resolveContextLink,
    });
    if (version.errorMessage) {
        const lastIndex = Math.max(0, chunks.length - 1);
        const lastChunk: FinalMessageChunk = chunks[lastIndex] ?? plainText('');
        chunks[lastIndex] = {
            ...appendErrorLine(
                lastChunk,
                formatErrorForUser({ message: version.errorMessage })
            ),
            linkPreviewOptions: lastChunk.linkPreviewOptions,
        };
    }
    return chunks;
};

/**
 * The version went out as its image alone. Judged by what it shows, as the
 * final delivery does: a reply without model text still shows its thinking
 * or tool records above the image, in a text message that can be edited.
 */
const isMediaOnlyVersion = (version: ResponseVersion): boolean =>
    Boolean(version.imageBase64 || version.sticker) && !buildVersionMessages(version)[0]?.text;

/**
 * Start a retry for an existing response
 */
export const startRetry = async (
    ctx: Context,
    firstMessageId: number
): Promise<BotMessageSession | null> => {
    if (!ctx.chat) return null;

    const chatId = ctx.chat.id;

    // Get existing response
    const response = await getBotResponse(chatId, firstMessageId);
    if (!response) {
        console.error('[bot-message-service] BotResponse not found for retry');
        return null;
    }

    const currentVersion = response.getCurrentVersion();
    if (!currentVersion) {
        // A restart cut the stream off before anything was stored: there is no
        // version to delete or switch, so regenerate into the message that is
        // already in the chat instead of failing silently
        console.warn('[bot-message-service] No stored version for retry, regenerating in place:', firstMessageId);
        return createSession(ctx, response.userMessageId, {
            isRetry: true,
            existingFirstMessageId: firstMessageId,
        });
    }

    // Check if current version is image-only (first message is a photo, can't be edited to text)
    const isCurrentMediaOnly = isMediaOnlyVersion(currentVersion);

    if (isCurrentMediaOnly) {
        // Delete all messages (they're all photos, can't edit to text)
        for (const msgId of currentVersion.messageIds) {
            if (msgId === undefined) continue;
            await to(ctx.api.deleteMessage(chatId, msgId));
        }
        // Send a fresh processing message, but keep DB anchor to original firstMessageId
        return createSession(ctx, response.userMessageId, {
            isRetry: true,
            dbAnchorMessageId: firstMessageId,
        });
    }

    // Delete extra messages (keep first — it's a text message we can edit)
    for (let i = 1; i < currentVersion.messageIds.length; i++) {
        const msgId = currentVersion.messageIds[i];
        if (msgId === undefined) continue;
        const [err] = await to(ctx.api.deleteMessage(chatId, msgId));
        if (err) {
            console.error('[bot-message-service] Failed to delete message:', err);
        }
    }

    // Reuse the existing first text message
    return createSession(ctx, response.userMessageId, {
        isRetry: true,
        existingFirstMessageId: firstMessageId,
    });
};

/**
 * Switch to a different version
 */
export const switchVersion = async (
    ctx: Context,
    firstMessageId: number,
    direction: 'prev' | 'next'
): Promise<boolean> => {
    if (!ctx.chat) return false;

    const chatId = ctx.chat.id;

    const response = await getBotResponse(chatId, firstMessageId);
    if (!response) return false;

    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;

    const newIndex = match(direction)
        .with('prev', () => currentIndex - 1)
        .with('next', () => currentIndex + 1)
        .exhaustive();
    if (newIndex < 0 || newIndex >= versions.length) return false;

    const oldVersion = versions[currentIndex];
    const newVersion = versions[newIndex];

    if (!oldVersion || !newVersion) return false;

    const resolveContextLink = buildMessageLinkResolver(chatId, response.userMessageId);

    // Format content using formatters; errored versions re-show their error line
    const contentChunks = buildVersionMessages(newVersion, resolveContextLink);
    let content: FinalMessageChunk = contentChunks[0] ?? plainText('');

    if (!content.text && !newVersion.imageBase64 && newVersion.sticker === undefined) {
        content = plainText('[Empty response]');
    }

    const versionButtons = buildResponseButtons(
        ButtonState.HAS_VERSIONS,
        newIndex,
        versions.length
    );

    const imageBuffer = newVersion.imageBase64 ? Buffer.from(newVersion.imageBase64, 'base64') : null;
    const sticker = newVersion.sticker;

    // A re-sent image keeps the caption it first went out with
    const captionFields = buildImageCaption(newVersion.imageCaption, resolveContextLink);
    // Same sender as the first delivery: a GIF version switch stays an animation
    const sendVersionImage = (image: Buffer) =>
        sendReplyImageMessage({
            api: ctx.api,
            chatId,
            image,
            captionFields,
            target: {
                reply_parameters: { message_id: response.userMessageId },
                reply_markup: versionButtons,
            },
            runApiCall: (operation) => runApiCall(chatId, operation),
        });
    // A sticker version goes back out as a sticker, not as the stored webp photo
    const sendVersionSticker = async (): Promise<Result<number>> => {
        if (sticker === undefined) return [new Error('version has no sticker'), undefined];
        const [error, message] = await to(
            runApiCall(chatId, () =>
                ctx.api.sendSticker(chatId, sticker.fileId, {
                    reply_parameters: { message_id: response.userMessageId },
                    reply_markup: versionButtons,
                })
            )
        );
        return error ? [error, undefined] : [null, message.message_id];
    };
    const sendVersionMedia = async (): Promise<Result<number>> => {
        if (sticker !== undefined) return sendVersionSticker();
        if (imageBuffer !== null) return sendVersionImage(imageBuffer);
        return [new Error('version has no media'), undefined];
    };

    const hasMedia = imageBuffer !== null || sticker !== undefined;
    const hasContent = Boolean(content.text);
    const newIsMediaOnly = hasMedia && !hasContent;
    const oldIsMediaOnly = isMediaOnlyVersion(oldVersion);

    // Determine if first message type changes (text <-> media-only)
    const firstMessageTypeChanged = newIsMediaOnly !== oldIsMediaOnly;

    // Delete old version's extra messages (keep first unless type changed)
    for (let i = 1; i < oldVersion.messageIds.length; i++) {
        const msgId = oldVersion.messageIds[i];
        if (msgId === undefined) continue;
        await to(ctx.api.deleteMessage(chatId, msgId));
    }

    const oldFirstMsgId = oldVersion.messageIds[0] ?? firstMessageId;
    const newMessageIds: number[] = [];
    let currentMessageId = firstMessageId;

    const editMessage = async (
        editor: MessageEditor,
        message: FinalMessageChunk,
        replyMarkup?: any
    ): Promise<boolean> => {
        const delivered = await editor.edit(message.text, {
            entities: message.entities,
            replyMarkup,
            linkPreviewOptions: message.linkPreviewOptions,
        });
        if (!delivered) {
            console.error('[bot-message-service] Failed to edit message');
        }
        return delivered;
    };

    if (firstMessageTypeChanged) {
        // Type mismatch: delete old first message, send new one
        await to(ctx.api.deleteMessage(chatId, oldFirstMsgId));

        if (newIsMediaOnly) {
            // Old was text → new is media-only
            const [sendErr, sentMsg] = await sendVersionMedia();
            if (!sendErr) {
                newMessageIds.push(sentMsg);
                currentMessageId = sentMsg;
            } else {
                console.error('[bot-message-service] Failed to send media:', sendErr);
                return false;
            }
        } else {
            // Old was image-only → new has text: send text message
            const firstText: FinalMessageChunk = content.text ? content : plainText('[Empty response]');
            const [sendErr, sentMsg] = await to(
                ctx.api.sendMessage(chatId, firstText.text, {
                    entities: toApiEntities(firstText.entities),
                    reply_parameters: { message_id: response.userMessageId },
                    reply_markup: hasMedia ? undefined : versionButtons,
                    link_preview_options: firstText.linkPreviewOptions,
                })
            );
            if (sendErr) {
                console.error('[bot-message-service] Failed to send text:', sendErr);
                return false;
            }
            newMessageIds.push(sentMsg.message_id);
            currentMessageId = sentMsg.message_id;

            // Send remaining chunks if multi-chunk
            for (let i = 1; i < contentChunks.length; i++) {
                const chunk = contentChunks[i];
                if (!chunk) continue;
                const isLast = i === contentChunks.length - 1 && !hasMedia;
                const [chunkErr, chunkMsg] = await to(
                    ctx.api.sendMessage(chatId, chunk.text, {
                        entities: toApiEntities(chunk.entities),
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: isLast ? versionButtons : undefined,
                        link_preview_options: chunk.linkPreviewOptions,
                    })
                );
                if (chunkErr) break;
                newMessageIds.push(chunkMsg.message_id);
                currentMessageId = chunkMsg.message_id;
            }

            // Send the visual attachment after text if present
            if (hasMedia) {
                const [mediaErr, mediaMsg] = await sendVersionMedia();
                if (!mediaErr) {
                    newMessageIds.push(mediaMsg);
                    currentMessageId = mediaMsg;
                }
            }
        }
    } else if (newIsMediaOnly) {
        // Both old and new are media-only: delete old media, send the new one
        await to(ctx.api.deleteMessage(chatId, oldFirstMsgId));

        const [sendErr, sentMsg] = await sendVersionMedia();
        if (!sendErr) {
            newMessageIds.push(sentMsg);
            currentMessageId = sentMsg;
        } else {
            console.error('[bot-message-service] Failed to send image:', sendErr);
            return false;
        }
    } else {
        // Both old and new have text: edit first message in place
        newMessageIds.push(oldFirstMsgId);
        currentMessageId = oldFirstMsgId;

        if (contentChunks.length > 1) {
            const editor = createMessageEditor(ctx.api, chatId, oldFirstMsgId);
            await editMessage(editor, content);

            for (let i = 1; i < contentChunks.length; i++) {
                const chunk = contentChunks[i];
                if (!chunk) continue;
                const isLast = i === contentChunks.length - 1 && !hasMedia;
                const [sendErr, sentMsg] = await to(
                    ctx.api.sendMessage(chatId, chunk.text, {
                        entities: toApiEntities(chunk.entities),
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: isLast ? versionButtons : undefined,
                        link_preview_options: chunk.linkPreviewOptions,
                    })
                );
                if (sendErr) break;
                newMessageIds.push(sentMsg.message_id);
                currentMessageId = sentMsg.message_id;
            }
        } else {
            const editor = createMessageEditor(ctx.api, chatId, oldFirstMsgId);
            await editMessage(
                editor,
                content.text ? content : plainText('[Empty response]'),
                hasMedia ? undefined : versionButtons
            );
        }

        // Send the visual attachment after text if present
        if (hasMedia) {
            const [sendErr, sentMsg] = await sendVersionMedia();
            if (!sendErr) {
                newMessageIds.push(sentMsg);
                currentMessageId = sentMsg;
            }
        }
    }

    // Update BotResponse database
    response.currentVersionIndex = newIndex;

    // Update messageIds in the version (they may have changed due to re-sending)
    newVersion.messageIds = newMessageIds;
    newVersion.currentMessageId = currentMessageId;
    response.setVersions(versions);

    await response.save();

    // Also overwrite the Message row with the new version's content, so the
    // context reads this version only — never its text next to another's image
    await writeBotMessageRow({
        chatId,
        messageId: firstMessageId,
        replyToId: response.userMessageId,
        date: new Date(),
        text: botRowTextOf({
            text: newVersion.text || '',
            wasStoppedByUser: newVersion.wasStoppedByUser,
            hasImage: hasMedia,
            imageCaption: newVersion.imageCaption,
        }),
        modelParts: newVersion.modelParts ?? null,
        file: imageBuffer,
        fileMime: imageBuffer ? sniffMediaMime(imageBuffer) : null,
        ...(newVersion.sticker === undefined ? {} : { mediaHint: 'sticker' }),
    });

    return true;
};

/**
 * Refresh a response's messages to the final state saved in the database.
 * Self-correction for messages stuck in an intermediate state (e.g. the final
 * edit was lost to a 429): rebuilds the final text and re-edits, including
 * button state. Returns false when there is nothing to restore.
 */
export const refreshToFinalState = async (
    api: Api,
    chatId: number,
    firstMessageId: number
): Promise<boolean> => {
    const response = await getBotResponse(chatId, firstMessageId);
    if (!response) return false;

    const versions = response.getVersions();
    const version = versions[response.currentVersionIndex];
    if (!version) return false;

    // Errored versions keep their error line across refreshes (display-only)
    const chunks = buildVersionMessages(version, buildMessageLinkResolver(chatId, response.userMessageId));
    if (chunks.length === 0) {
        chunks.push(plainText('[Empty response]'));
    }

    const buttons = buildResponseButtons(
        response.buttonState,
        response.currentVersionIndex,
        versions.length
    );

    // Media messages can't be edited to text: pair chunks with text messages only.
    // When a visual attachment exists it is the last message (currentMessageId) and carries the buttons.
    const hasMedia = Boolean(version.imageBase64 || version.sticker);
    const textMessageIds = hasMedia
        ? version.messageIds.filter((id) => id !== version.currentMessageId)
        : version.messageIds;

    let allDelivered = true;
    const editableCount = Math.min(chunks.length, textMessageIds.length);

    for (let i = 0; i < editableCount; i++) {
        const messageId = textMessageIds[i];
        const chunk = chunks[i];
        if (messageId === undefined || chunk === undefined) continue;

        const carriesButtons = !hasMedia && i === chunks.length - 1;
        const delivered = await submitEdit(api, chatId, messageId, chunk.text, {
            entities: chunk.entities,
            replyMarkup: carriesButtons ? buttons : undefined,
            linkPreviewOptions: chunk.linkPreviewOptions,
            isFinal: true,
        });
        if (!delivered) allDelivered = false;
    }

    // Final content needs more messages than exist (stream died before a
    // continuation was created): append the overflow chunks as new messages
    if (chunks.length > textMessageIds.length) {
        let messageIdsChanged = false;
        for (let i = textMessageIds.length; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk === undefined) continue;
            const carriesButtons = !hasMedia && i === chunks.length - 1;
            const [sendErr, sentMsg] = await to(
                runApiCall(chatId, () =>
                    api.sendMessage(chatId, chunk.text, {
                        entities: toApiEntities(chunk.entities),
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: carriesButtons ? buttons : undefined,
                        link_preview_options: chunk.linkPreviewOptions,
                    })
                )
            );
            if (sendErr) {
                console.error('[bot-message-service] Refresh: failed to send overflow chunk:', sendErr);
                allDelivered = false;
                break;
            }
            version.messageIds.push(sentMsg.message_id);
            if (!hasMedia) {
                version.currentMessageId = sentMsg.message_id;
            }
            registerContinuation(chatId, sentMsg.message_id, firstMessageId);
            messageIdsChanged = true;
        }
        if (messageIdsChanged) {
            response.setVersions(versions);
            await response.save();
        }
    }

    // The media message carries the buttons: refresh its markup separately
    if (hasMedia && buttons) {
        const [markupErr] = await to(
            runApiCall(chatId, () =>
                api.editMessageReplyMarkup(chatId, version.currentMessageId, {
                    reply_markup: buttons,
                })
            )
        );
        if (markupErr && !markupErr.message.includes('message is not modified')) {
            console.warn('[bot-message-service] Refresh: markup update failed:', markupErr.message);
            allDelivered = false;
        }
    }

    return allDelivered;
};

/**
 * Get BotResponse by first message ID
 */
export { getBotResponse, findBotResponseByMessageId };
