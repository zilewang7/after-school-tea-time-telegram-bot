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
    type StoredFile,
    type StoredSticker,
    type CommandType,
} from '../db/index.js';
import type { StoredWidget } from '../db/botResponseDTO.js';
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
import { sendReplyFileMessage } from '../telegram/reply-file-send.js';
import {
    sendReplyWidgetLinkMessage,
    sendReplyWidgetMessage,
} from '../telegram/reply-widget-send.js';
import { editWidgetReplyMarkup } from '../telegram/widget-api.js';
import { sendReplyImageMessage } from '../telegram/reply-image-send.js';
import { isWidgetRenderConfigured, renderWidgetPng } from '../widget-image/index.js';
import { ensureSystemReplyShare, findActiveShare, previewLinkUrlOf } from '../panel/share/share-link-service.js';
import type { ShareLinkRecord } from '../panel/share/share-types.js';
import { shareTokenOfUrl } from '../panel/share/share-urls.js';
import {
    buildWidgetLinkMessage,
    miniAppShortName,
    widgetMiniAppLink,
} from '../reply/widget-link-fallback.js';
import { resolveChatModel } from '../config/chat-model.js';
import type { ContextLinkResolver } from '../telegram/formatters/context-links.js';
import type { AgentStats, FileDelivery, StickerDelivery, WidgetDelivery } from '../ai/types.js';
import { classifyErrorKind, summarizeErrorMessage, type ErrorKind } from '../shared/error-kind.js';
import { createReplyMetricsDraft, type ReplyMetricsDraft } from './reply-metrics-draft.js';
import { recordReplyMetric } from './reply-metric-record.js';
import { pushRecentReplyError } from './recent-reply-errors.js';

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
    /** What kind of failure errorMessage is, for the reply metrics */
    errorKind?: ErrorKind;
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

    /** The model this version is generated with, as the caller chose it */
    model: string;

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
    /** The file this reply sent, when it sent one instead of an image or sticker */
    file?: FileDelivery;
    /** The chat UI card this reply sent, when it sent one instead of other media */
    widget?: WidgetDelivery;
    /** Telegram message id of the widget message */
    widgetMessageId?: number;
    /** The 600px rendered card image (PNG, base64) for storage and the next context */
    widgetImageBase64?: string;
    /** How the card reached the chat: native widget (private) or the Mini App link fallback */
    widgetDeliveredAs?: 'widget' | 'link';
    /** Share page URL the link fallback's preview points at */
    widgetShareUrl?: string;
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

    /** Timings, context size and usage of this attempt, written to reply_metrics at finalize */
    metrics: ReplyMetricsDraft;
    /** The tool status the editor shows right now; null while no tool runs */
    statusLine: string | null;

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
    /**
     * The model generating this reply, recorded in the metadata and the
     * version. Passed in rather than looked up, so the record always names
     * the model the caller actually sent the request to.
     */
    model: string;
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

/** Every reply still being generated, for the panel's live status (read only) */
export const listActiveSessions = (): readonly BotMessageSession[] => [...activeSessions.values()];

/**
 * Create a new bot message session
 */
export const createSession = async (
    ctx: Context,
    userMessageId: number,
    options: CreateSessionOptions
): Promise<BotMessageSession | null> => {
    if (!ctx.chat) return null;

    const chatId = ctx.chat.id;
    const api = ctx.api;
    // Taken first: the attempt's clock includes the placeholder and the context build
    const metrics = createReplyMetricsDraft({
        model: options.model,
        commandType: options.commandType ?? 'chat',
        triggerUserId: ctx.from?.id ?? null,
    });

    // For retry, we reuse the existing first message
    let firstMessageId = options.dbAnchorMessageId ?? options.existingFirstMessageId;
    let processingMsgId: number;

    // Initial status text (matches first entry in streaming-editor statusData)
    const initialStatus = '✽ Thinking...';

    // Build stop button for processing state
    const stopButton = buildResponseButtons(ButtonState.PROCESSING);

    if (options.isRetry && options.existingFirstMessageId) {
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
    const dbLookupId = options.dbAnchorMessageId ?? options.existingFirstMessageId;
    if (options.isRetry && dbLookupId) {
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
        model: options.model,
        messageIds: [processingMsgId],
        currentMessageId: processingMsgId,
        editor,
        textBuffer: '',
        thinkingBuffer: '',
        images: [],
        groundingData: [],
        agentStats: undefined,
        streamController,
        isRetry: options.isRetry ?? false,
        versionCount,
        isFinalized: false,
        api,
        metrics,
        statusLine: null,

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
    if (!options.isRetry) {
        const metadata: ResponseMetadata = {
            model: options.model,
            hasImage: false,
            commandType: options.commandType,
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
 * there is no text at all.
 *
 * `[Empty response]` is a display placeholder for a reply that produced no
 * text, and must not be stored: a context reading it back cannot tell an
 * interrupted reply from one that is still streaming (the in-flight note only
 * applies to turns with no text), and the model then reads the placeholder as
 * the content of its own message.
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

    return parts.length > 0 ? parts.join('\n\n') : null;
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
    const finishedAt = new Date();

    const sessionKey = getSessionKey(session.chatId, session.firstMessageId);

    // Last line of defense before the reply is versioned and stored: text that
    // never went through the stream processor (image-chat turns and the like)
    // loses its imitated `[#N]` labels here as well
    session.textBuffer = stripContextLabel(session.textBuffer);

    const image = session.images[0];
    const sticker = session.sticker;
    const file = session.file;
    const widget = session.widget;
    const widgetImage =
        session.widgetImageBase64 !== undefined
            ? Buffer.from(session.widgetImageBase64, 'base64')
            : undefined;
    // Picture bytes: an image, or the sticker's webp. A file has its own slot.
    // The row keeps picture bytes only: a file is named by its mediaHint, its
    // bytes live in the version (for a version switch), never in the prompt.
    // A card's rendered PNG takes the same slot, so the next context sees it.
    const pictureBuffer = sticker ? session.stickerBytes : image;
    const rowPicture = pictureBuffer ?? widgetImage;
    const mediaMime = rowPicture ? sniffMediaMime(rowPicture) : null;
    // Only the delivered attachment has a caption; stickers have none
    const imageCaption = image && options?.imageCaption ? options.imageCaption : undefined;
    const fileCaption = file?.caption;

    // Build version data
    const version: ResponseVersion = {
        versionId: session.versionCount + 1,
        createdAt: new Date().toISOString(),
        model: session.model,
        messageIds: [...session.messageIds],
        currentMessageId: session.currentMessageId,
        text: session.textBuffer,
        thinkingText: session.thinkingBuffer || undefined,
        groundingData: session.groundingData.length ? session.groundingData : undefined,
        agentStats: session.agentStats,
        errorMessage: options?.errorMessage,
        modelParts: options?.modelParts,
        wasStoppedByUser: options?.wasStoppedByUser ?? false,
        ...(widget === undefined
            ? {}
            : {
                  widget: {
                      mode: widget.mode,
                      html: widget.html,
                      ...(widget.caption !== undefined ? { caption: widget.caption } : {}),
                      ...(session.widgetMessageId !== undefined
                          ? { messageId: session.widgetMessageId }
                          : {}),
                      htmlBytes: widget.htmlBytes,
                      zlibBytes: widget.zlibBytes,
                      ...(widget.surface === undefined ? {} : { surface: widget.surface }),
                      ...(session.widgetImageBase64 !== undefined
                          ? { imageBase64: session.widgetImageBase64 }
                          : {}),
                      ...(session.widgetDeliveredAs !== undefined
                          ? { deliveredAs: session.widgetDeliveredAs }
                          : {}),
                      ...(session.widgetShareUrl !== undefined
                          ? { shareUrl: session.widgetShareUrl }
                          : {}),
                  },
              }),
        imageBase64: pictureBuffer?.toString('base64'),
        imageCaption: sticker !== undefined || file !== undefined ? undefined : imageCaption,
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
        ...(file === undefined
            ? {}
            : {
                  file: {
                      name: file.name,
                      mimeType: file.mimeType,
                      sizeBytes: file.data.length,
                      ...(fileCaption ? { caption: fileCaption } : {}),
                  } satisfies StoredFile,
                  fileBase64: file.data.toString('base64'),
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

        // The metadata names the model of the latest version (a retry may
        // use another one) and whether the reply ever carried an attachment
        const carriesAttachment =
            session.images.length > 0 || sticker !== undefined || file !== undefined || widget !== undefined;
        response.setMetadata({
            ...response.getMetadata(),
            model: session.model,
            ...(carriesAttachment ? { hasImage: true } : {}),
            ...(sticker !== undefined ? { hasSticker: true } : {}),
            ...(file !== undefined ? { hasFile: true } : {}),
            ...(widget !== undefined ? { hasWidget: true } : {}),
        });

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
            // "has an attachment": its caption joins the stored text
            hasImage: pictureBuffer !== undefined || file !== undefined || widget !== undefined,
            imageCaption:
                sticker !== undefined
                    ? undefined
                    : file !== undefined
                      ? fileCaption
                      : widget !== undefined
                        ? widget.caption
                        : imageCaption,
        }),
        modelParts: options?.modelParts ?? null,
        file: rowPicture ?? null,
        fileMime: mediaMime,
        ...(sticker !== undefined
            ? { mediaHint: 'sticker' }
            : file !== undefined
              ? { mediaHint: `a file: ${file.name}, ${file.mimeType}` }
              : widget !== undefined
                ? { mediaHint: 'a widget' }
              : rowPicture !== undefined
                ? { mediaHint: 'a picture' }
                : {}),
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

    // After the cleanup, and never throwing: a failed metrics write costs the
    // panel one row, not the reply its finalize
    await recordReplyMetric(session, {
        versionId: version.versionId,
        errorMessage: options?.errorMessage,
        errorKind: options?.errorKind,
        wasStoppedByUser: options?.wasStoppedByUser ?? false,
        finishedAt,
    });
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

    // No request out yet means the reply failed while reading or building
    const errorKind = classifyErrorKind(error, { beforeRequest: session.metrics.requestStartedAt === null });
    pushRecentReplyError({
        at: new Date(),
        chatId: session.chatId,
        model: session.model,
        errorKind,
        errorSummary: summarizeErrorMessage(error.message),
        firstMessageId: session.firstMessageId,
    });

    await finalizeSession(session, {
        errorMessage: error.message,
        errorKind,
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
    Boolean(version.imageBase64 || version.fileBase64 || version.sticker || version.widget) &&
    !buildVersionMessages(version)[0]?.text;

/**
 * Start a retry for an existing response. `options.model` is the model the
 * new version is generated with; without it, the chat's model right now (never
 * the one the original version used).
 */
export const startRetry = async (
    ctx: Context,
    firstMessageId: number,
    options?: { model?: string }
): Promise<BotMessageSession | null> => {
    if (!ctx.chat) return null;

    const chatId = ctx.chat.id;
    const model = options?.model ?? resolveChatModel(chatId);

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
            model,
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
            model,
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
        model,
        isRetry: true,
        existingFirstMessageId: firstMessageId,
    });
};

/**
 * The rendered 600px card image of a stored widget version. A version stored
 * without one (the renderer was down when it went out) renders now and keeps
 * the result, so a later switch does not pay for it again.
 */
const widgetImageOf = async (widget: StoredWidget): Promise<Buffer | null> => {
    if (widget.imageBase64 !== undefined) return Buffer.from(widget.imageBase64, 'base64');
    if (!isWidgetRenderConfigured()) return null;
    const rendered = await renderWidgetPng(widget.html, { width: 600 });
    if (rendered === null) return null;
    widget.imageBase64 = rendered.png.toString('base64');
    return rendered.png;
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

    if (
        !content.text &&
        !newVersion.imageBase64 &&
        !newVersion.fileBase64 &&
        newVersion.sticker === undefined &&
        newVersion.widget === undefined
    ) {
        content = plainText('[Empty response]');
    }

    const versionButtons = buildResponseButtons(
        ButtonState.HAS_VERSIONS,
        newIndex,
        versions.length
    );

    const imageBuffer = newVersion.imageBase64 ? Buffer.from(newVersion.imageBase64, 'base64') : null;
    const sticker = newVersion.sticker;
    const storedFile = newVersion.file;
    const storedWidget = newVersion.widget;
    const fileBuffer = newVersion.fileBase64 ? Buffer.from(newVersion.fileBase64, 'base64') : null;
    // The card's rendered PNG is part of the version (the bot row replays it);
    // a version stored without one renders now, and the switch fails if it
    // cannot — the alternative is a version whose card the next turn cannot see.
    const widgetImage = storedWidget === undefined ? null : await widgetImageOf(storedWidget);
    if (storedWidget !== undefined && widgetImage === null) {
        console.error('[bot-message-service] widget version has no image and the renderer is unavailable');
        return false;
    }

    // A re-sent image keeps the caption it first went out with
    const captionFields = buildImageCaption(newVersion.imageCaption, resolveContextLink);
    const fileCaptionFields = buildImageCaption(storedFile?.caption, resolveContextLink);
    const widgetCaptionFields = buildImageCaption(storedWidget?.caption, resolveContextLink);
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
    // A file version re-uploads the stored bytes with its original name
    const sendVersionFile = (): Promise<Result<number>> => {
        if (storedFile === undefined || fileBuffer === null) {
            return Promise.resolve([new Error('version has no file'), undefined]);
        }
        return sendReplyFileMessage({
            api: ctx.api,
            chatId,
            file: {
                name: storedFile.name,
                mimeType: storedFile.mimeType,
                data: fileBuffer,
                ...(storedFile.caption ? { caption: storedFile.caption } : {}),
            },
            captionFields: fileCaptionFields,
            target: {
                reply_parameters: { message_id: response.userMessageId },
                reply_markup: versionButtons,
            },
            runApiCall: (operation) => runApiCall(chatId, operation),
        });
    };
    // The link fallback again: reuse the stored share page (its token is what
    // the Mini App link needs), or make the share now. A stored page without a
    // widget render is refreshed, so the link can preview the card image.
    const sendVersionWidgetLink = async (widget: StoredWidget): Promise<Result<number>> => {
        const botUsername = ctx.me.username;
        if (botUsername === undefined || botUsername.length === 0) {
            return [new Error('no bot username for the Mini App link'), undefined];
        }
        let share: ShareLinkRecord | null = null;
        const storedToken = widget.shareUrl === undefined ? null : shareTokenOfUrl(widget.shareUrl);
        if (storedToken !== null) share = await findActiveShare(storedToken);
        if (share === null || previewLinkUrlOf(share) === null) {
            const [error, ensured] = await to(
                ensureSystemReplyShare({
                    chatId,
                    firstMessageId,
                    versionId: newVersion.versionId,
                })
            );
            if (error !== null) {
                console.error('[bot-message-service] share page for the widget link failed:', error);
            }
            const ensuredShare = ensured ?? null;
            if (ensuredShare !== null) share = ensuredShare;
        }
        const previewUrl = share === null ? null : previewLinkUrlOf(share);
        const message = buildWidgetLinkMessage({
            caption: widgetCaptionFields,
            ...(previewUrl === null ? {} : { previewUrl }),
            miniAppLink: widgetMiniAppLink({
                botUsername,
                shortName: miniAppShortName(),
                chatId,
                firstMessageId,
                shareToken: share?.token ?? null,
            }),
            replyToMessageId: response.userMessageId,
        });
        return sendReplyWidgetLinkMessage({
            chatId,
            api: ctx.api,
            message,
            replyMarkup: versionButtons,
        });
    };
    // A widget version re-sends the stored card: the native widget in a private
    // chat, the Mini App link in a group (or after a server refusal)
    const sendVersionWidget = async (): Promise<Result<number>> => {
        if (storedWidget === undefined) {
            return [new Error('version has no widget'), undefined];
        }
        if (storedWidget.deliveredAs === 'link') return sendVersionWidgetLink(storedWidget);
        return sendReplyWidgetMessage({
            chatId,
            widget: {
                mode: storedWidget.mode,
                html: storedWidget.html,
                ...(storedWidget.caption !== undefined ? { caption: storedWidget.caption } : {}),
                htmlBytes: storedWidget.htmlBytes,
                zlibBytes: storedWidget.zlibBytes,
                ...(storedWidget.surface === undefined ? {} : { surface: storedWidget.surface }),
            },
            captionFields: widgetCaptionFields,
            target: {
                reply_parameters: { message_id: response.userMessageId },
                reply_markup: versionButtons,
            },
        });
    };
    const sendVersionMedia = async (): Promise<Result<number>> => {
        if (storedWidget !== undefined) return sendVersionWidget();
        if (fileBuffer !== null) return sendVersionFile();
        if (sticker !== undefined) return sendVersionSticker();
        if (imageBuffer !== null) return sendVersionImage(imageBuffer);
        return [new Error('version has no media'), undefined];
    };

    const hasMedia =
        imageBuffer !== null ||
        fileBuffer !== null ||
        sticker !== undefined ||
        storedWidget !== undefined;
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
    const rowPicture = imageBuffer ?? widgetImage;
    await writeBotMessageRow({
        chatId,
        messageId: firstMessageId,
        replyToId: response.userMessageId,
        date: new Date(),
        text: botRowTextOf({
            text: newVersion.text || '',
            wasStoppedByUser: newVersion.wasStoppedByUser,
            hasImage: hasMedia,
            imageCaption:
                newVersion.sticker !== undefined
                    ? undefined
                    : storedFile !== undefined
                      ? storedFile.caption
                      : storedWidget !== undefined
                        ? storedWidget.caption
                        : newVersion.imageCaption,
        }),
        modelParts: newVersion.modelParts ?? null,
        file: rowPicture,
        fileMime: rowPicture ? sniffMediaMime(rowPicture) : null,
        ...(newVersion.sticker !== undefined
            ? { mediaHint: 'sticker' }
            : storedFile !== undefined
              ? { mediaHint: `a file: ${storedFile.name}, ${storedFile.mimeType}` }
              : storedWidget !== undefined
                ? { mediaHint: 'a widget' }
                : imageBuffer
                  ? { mediaHint: 'a picture' }
                  : {}),
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
    const hasMedia = Boolean(
        version.imageBase64 || version.fileBase64 || version.sticker || version.widget
    );
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
        if (markupErr && version.widget !== undefined && version.widget.deliveredAs !== 'link') {
            // A native widget message can only be edited through the client that sent it
            const [widgetErr] = await to(
                editWidgetReplyMarkup(chatId, version.currentMessageId, buttons)
            );
            if (widgetErr !== null) {
                console.warn('[bot-message-service] Refresh: widget markup update failed:', widgetErr);
                allDelivered = false;
            }
        } else if (markupErr && !markupErr.message.includes('message is not modified')) {
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
