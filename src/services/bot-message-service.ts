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
    type ResponseVersion,
    type ResponseMetadata,
    type CommandType,
} from '../db';
import {
    createMessageEditor,
    type MessageEditor,
} from '../telegram';
import { buildFinalMessageChunks } from '../telegram/formatters/final-message-builder';
import { formatResponse } from '../telegram/formatters/markdown-formatter';
import { buildResponseButtons } from '../cmd/menus';
import { to, isErr } from '../shared/result';
import { getCurrentModel } from '../state';
import type { AgentStats } from '../ai/types';

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
    const initialStatus = '✽ Thinking\\.\\.\\.';

    // Build stop button for processing state
    const stopButton = buildResponseButtons(ButtonState.PROCESSING);

    if (options?.isRetry && options.existingFirstMessageId) {
        // Edit existing first message with stop button
        processingMsgId = options.existingFirstMessageId;
        const editor = createMessageEditor(api, chatId, processingMsgId);
        await editor.edit(initialStatus, {
            parseMode: 'MarkdownV2',
            replyMarkup: stopButton,
        });
    } else {
        // Send new processing message with stop button
        const sendResult = await to(
            ctx.reply(initialStatus, {
                parse_mode: 'MarkdownV2',
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
        session.api.sendMessage(session.chatId, `continued`, {
            parse_mode: 'MarkdownV2',
            reply_parameters: { message_id: session.userMessageId },
        })
    );

    if (isErr(sendResult)) {
        console.error('[bot-message-service] Failed to create continuation:', sendResult[0]);
        return null;
    }

    const newMessageId = sendResult[1].message_id;
    session.messageIds.push(newMessageId);
    session.currentMessageId = newMessageId;
    session.editor = createMessageEditor(session.api, session.chatId, newMessageId);

    return session.editor;
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
        imageBase64: session.images[0]?.toString('base64'),
    };

    // Update BotResponse database
    const response = await getBotResponse(session.chatId, session.firstMessageId);
    if (response) {
        response.addVersion(version);

        // Determine button state
        const hasMultipleVersions = response.getVersions().length > 1;
        const hasError = options?.wasStoppedByUser || options?.errorMessage;
        response.buttonState = match({ hasMultipleVersions, hasError })
            .with({ hasMultipleVersions: true }, () => ButtonState.HAS_VERSIONS)
            .with({ hasError: true }, () => ButtonState.RETRY_ONLY)
            .otherwise(() => ButtonState.NONE);

        // Update metadata if has images
        if (session.images.length > 0) {
            const metadata = response.getMetadata();
            metadata.hasImage = true;
            response.setMetadata(metadata);
        }

        await response.save();

        // Add to edit monitor if no buttons (normal completion)
        if (response.buttonState === ButtonState.NONE) {
            const { addEditMonitorEntry } = await import('../state');
            addEditMonitorEntry(session.chatId, session.userMessageId, session.firstMessageId);
        }
    }

    // Also save to Message table for context building
    // This ensures bot messages appear in the reply chain
    // Bot message is ONE record with text + image (if any)
    // Include [stopped] or [Empty response] markers for context consistency
    let messageText = session.textBuffer || '';
    if (options?.wasStoppedByUser) {
        messageText = messageText ? `${messageText}\n\n[stopped]` : '[stopped]';
    }
    if (!messageText && !session.images.length) {
        messageText = '[Empty response]';
    }

    const { saveMessage } = await import('../db');
    await saveMessage({
        chatId: session.chatId,
        messageId: session.firstMessageId,
        userId: Number(process.env.BOT_USER_ID),
        date: new Date(),
        userName: process.env.BOT_NAME || 'Bot',
        message: messageText || undefined,
        replyToId: session.userMessageId,
        modelParts: options?.modelParts,
        fileBuffer: session.images[0], // First image if any
    });

    // Remove from active sessions
    activeSessions.delete(sessionKey);
};

/**
 * Handle session error - update message with error and retry button
 */
const handleSessionError = async (session: BotMessageSession, error: Error): Promise<void> => {
    console.error('[bot-message-service] Session error:', error);

    await finalizeSession(session, {
        errorMessage: error.message,
    });

    // Update message with error content and retry button
    const errorContent = session.textBuffer
        ? `${formatResponse(session.textBuffer, session.thinkingBuffer)}\n\n_Error: ${error.message.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}_`
        : `_Error: ${error.message.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}_`;

    const retryButtons = buildResponseButtons(ButtonState.RETRY_ONLY);

    const [err] = await to(session.editor.edit(errorContent, {
        parseMode: 'MarkdownV2',
        replyMarkup: retryButtons,
    }));

    if (err) {
        console.error('[bot-message-service] Failed to update error message:', err);
    }
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
        console.error('[bot-message-service] No current version for retry');
        return null;
    }

    // Check if current version is image-only (first message is a photo, can't be edited to text)
    const isCurrentImageOnly = Boolean(!currentVersion.text && currentVersion.imageBase64);

    if (isCurrentImageOnly) {
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

    // Format content using formatters
    const contentChunks = buildFinalMessageChunks({
        text: newVersion.text || '',
        thinking: newVersion.thinkingText,
        agentStats: newVersion.agentStats,
        groundingData: newVersion.groundingData,
        wasStoppedByUser: newVersion.wasStoppedByUser,
    });
    let content = contentChunks[0] ?? '';

    if (!content && !newVersion.imageBase64) {
        content = '\\[Empty response\\]';
    }

    const versionButtons = buildResponseButtons(
        ButtonState.HAS_VERSIONS,
        newIndex,
        versions.length
    );

    let imageBuffer: Buffer | null = null;
    if (newVersion.imageBase64) {
        imageBuffer = Buffer.from(newVersion.imageBase64, 'base64');
    }

    const hasImage = imageBuffer !== null;
    const hasContent = Boolean(content);
    const newIsImageOnly = hasImage && !hasContent;
    const oldIsImageOnly = Boolean(!oldVersion.text && oldVersion.imageBase64);

    // Determine if first message type changes (text <-> image-only)
    const firstMessageTypeChanged = newIsImageOnly !== oldIsImageOnly;

    // Delete old version's extra messages (keep first unless type changed)
    for (let i = 1; i < oldVersion.messageIds.length; i++) {
        const msgId = oldVersion.messageIds[i];
        if (msgId === undefined) continue;
        await to(ctx.api.deleteMessage(chatId, msgId));
    }

    const oldFirstMsgId = oldVersion.messageIds[0] ?? firstMessageId;
    const newMessageIds: number[] = [];
    let currentMessageId = firstMessageId;

    /**
     * Helper to edit a text message with Markdown parse error fallback
     */
    const editWithFallback = async (
        editor: MessageEditor,
        text: string,
        options?: { parseMode?: 'MarkdownV2'; replyMarkup?: any }
    ): Promise<boolean> => {
        const [editErr] = await to(editor.edit(text, options));
        if (!editErr) return true;
        const errMsg = editErr.message || '';
        if (errMsg.includes("can't parse entities")) {
            console.warn('[bot-message-service] Markdown parse error, retrying with escaped text');
            const escaped = text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            const [retryErr] = await to(editor.edit(escaped, options));
            if (!retryErr) return true;
            console.error('[bot-message-service] Escaped text also failed:', retryErr);
        } else {
            console.error('[bot-message-service] Failed to edit message:', editErr);
        }
        return false;
    };

    if (firstMessageTypeChanged) {
        // Type mismatch: delete old first message, send new one
        await to(ctx.api.deleteMessage(chatId, oldFirstMsgId));

        if (newIsImageOnly) {
            // Old was text → new is image-only
            const { InputFile } = await import('grammy');
            const [sendErr, sentMsg] = await to(
                ctx.api.sendPhoto(chatId, new InputFile(imageBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png'), {
                    reply_parameters: { message_id: response.userMessageId },
                    reply_markup: versionButtons,
                })
            );
            if (!sendErr) {
                newMessageIds.push(sentMsg.message_id);
                currentMessageId = sentMsg.message_id;
            } else {
                console.error('[bot-message-service] Failed to send image:', sendErr);
                return false;
            }
        } else {
            // Old was image-only → new has text: send text message
            const [sendErr, sentMsg] = await to(
                ctx.api.sendMessage(chatId, content || '\\[Empty response\\]', {
                    parse_mode: 'MarkdownV2',
                    reply_parameters: { message_id: response.userMessageId },
                    reply_markup: hasImage ? undefined : versionButtons,
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
                const chunk = contentChunks[i] ?? '';
                const isLast = i === contentChunks.length - 1 && !hasImage;
                const [chunkErr, chunkMsg] = await to(
                    ctx.api.sendMessage(chatId, chunk, {
                        parse_mode: 'MarkdownV2',
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: isLast ? versionButtons : undefined,
                    })
                );
                if (chunkErr) break;
                newMessageIds.push(chunkMsg.message_id);
                currentMessageId = chunkMsg.message_id;
            }

            // Send image after text if present
            if (hasImage && imageBuffer) {
                const { InputFile } = await import('grammy');
                const [imgErr, imgMsg] = await to(
                    ctx.api.sendPhoto(chatId, new InputFile(imageBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png'), {
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: versionButtons,
                    })
                );
                if (!imgErr) {
                    newMessageIds.push(imgMsg.message_id);
                    currentMessageId = imgMsg.message_id;
                }
            }
        }
    } else if (newIsImageOnly) {
        // Both old and new are image-only: delete old image, send new image
        await to(ctx.api.deleteMessage(chatId, oldFirstMsgId));

        const { InputFile } = await import('grammy');
        const [sendErr, sentMsg] = await to(
            ctx.api.sendPhoto(chatId, new InputFile(imageBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png'), {
                reply_parameters: { message_id: response.userMessageId },
                reply_markup: versionButtons,
            })
        );
        if (!sendErr) {
            newMessageIds.push(sentMsg.message_id);
            currentMessageId = sentMsg.message_id;
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
            await editWithFallback(editor, contentChunks[0] ?? '', { parseMode: 'MarkdownV2' });

            for (let i = 1; i < contentChunks.length; i++) {
                const chunk = contentChunks[i] ?? '';
                const isLast = i === contentChunks.length - 1 && !hasImage;
                const [sendErr, sentMsg] = await to(
                    ctx.api.sendMessage(chatId, chunk, {
                        parse_mode: 'MarkdownV2',
                        reply_parameters: { message_id: response.userMessageId },
                        reply_markup: isLast ? versionButtons : undefined,
                    })
                );
                if (sendErr) break;
                newMessageIds.push(sentMsg.message_id);
                currentMessageId = sentMsg.message_id;
            }
        } else {
            const editor = createMessageEditor(ctx.api, chatId, oldFirstMsgId);
            await editWithFallback(
                editor,
                content || '\\[Empty response\\]',
                {
                    parseMode: 'MarkdownV2',
                    replyMarkup: hasImage ? undefined : versionButtons,
                }
            );
        }

        // Send image after text if present
        if (hasImage && imageBuffer) {
            const { InputFile } = await import('grammy');
            const [sendErr, sentMsg] = await to(
                ctx.api.sendPhoto(chatId, new InputFile(imageBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png'), {
                    reply_parameters: { message_id: response.userMessageId },
                    reply_markup: versionButtons,
                })
            );
            if (!sendErr) {
                newMessageIds.push(sentMsg.message_id);
                currentMessageId = sentMsg.message_id;
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

    // Also update Message table with new version's content
    // This ensures context building uses the correct version
    // Include [stopped] or [Empty response] markers for context consistency
    let messageText = newVersion.text || '';
    if (newVersion.wasStoppedByUser) {
        messageText = messageText ? `${messageText}\n\n[stopped]` : '[stopped]';
    }
    if (!messageText && !imageBuffer) {
        messageText = '[Empty response]';
    }

    const { saveMessage } = await import('../db');
    await saveMessage({
        chatId,
        messageId: firstMessageId,
        userId: Number(process.env.BOT_USER_ID),
        date: new Date(),
        userName: process.env.BOT_NAME || 'Bot',
        message: messageText || undefined,
        replyToId: response.userMessageId,
        modelParts: newVersion.modelParts,
        fileBuffer: imageBuffer ?? undefined,
    });

    return true;
};

/**
 * Get BotResponse by first message ID
 */
export { getBotResponse, findBotResponseByMessageId };
