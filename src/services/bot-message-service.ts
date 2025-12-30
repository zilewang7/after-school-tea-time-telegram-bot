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
    getMessage,
    type ResponseVersion,
    type ResponseMetadata,
    type CommandType,
} from '../db';
import {
    createMessageEditor,
    type MessageEditor,
} from '../telegram';
import { formatResponse, formatResponseSafe } from '../telegram/formatters/markdown-formatter';
import { appendGroundingToMessage } from '../telegram/formatters/grounding-formatter';
import { smartSplit, needsSplit } from '../telegram/formatters/smart-splitter';
import { buildResponseButtons } from '../cmd/menus';
import { to, isErr } from '../shared/result';
import { getCurrentModel } from '../state';

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
    let firstMessageId = options?.existingFirstMessageId;
    let processingMsgId: number;

    // Initial status text (matches first entry in streaming-editor statusData)
    const initialStatus = '✽ Thinking\\.\\.\\.';

    // Build stop button for processing state
    const stopButton = buildResponseButtons(ButtonState.PROCESSING);

    if (options?.isRetry && firstMessageId) {
        // Edit existing first message with stop button
        processingMsgId = firstMessageId;
        const editor = createMessageEditor(api, chatId, firstMessageId);
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
        firstMessageId = processingMsgId;
    }

    const streamController = createStreamController();
    const editor = createMessageEditor(api, chatId, processingMsgId);

    // Get existing version count if retry
    let versionCount = 0;
    if (options?.isRetry && options.existingFirstMessageId) {
        const existing = await getBotResponse(chatId, options.existingFirstMessageId);
        if (existing) {
            versionCount = existing.getVersions().length;
        }
    }

    // Create session object
    const session: BotMessageSession = {
        chatId,
        userMessageId,
        firstMessageId,
        messageIds: [processingMsgId],
        currentMessageId: processingMsgId,
        editor,
        textBuffer: '',
        thinkingBuffer: '',
        images: [],
        groundingData: [],
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
    const sessionKey = getSessionKey(chatId, firstMessageId);
    activeSessions.set(sessionKey, session);

    // Initialize database record for new response (not retry)
    if (!options?.isRetry) {
        const metadata: ResponseMetadata = {
            model: getCurrentModel(),
            hasImage: false,
            commandType: options?.commandType,
        };
        await createBotResponse(chatId, firstMessageId, userMessageId, metadata);
    } else {
        // Update button state to processing for retry
        const response = await getBotResponse(chatId, firstMessageId);
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

    // Delete extra messages (keep first)
    for (let i = 1; i < currentVersion.messageIds.length; i++) {
        const msgId = currentVersion.messageIds[i];
        if (msgId === undefined) continue;
        const [err] = await to(ctx.api.deleteMessage(chatId, msgId));
        if (err) {
            console.error('[bot-message-service] Failed to delete message:', err);
        }
    }

    // Create new session with retry flag
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

    // Delete old version's extra messages (keep first)
    for (let i = 1; i < oldVersion.messageIds.length; i++) {
        const msgId = oldVersion.messageIds[i];
        if (msgId === undefined) continue;
        // Message may already be deleted, ignore errors
        await to(ctx.api.deleteMessage(chatId, msgId));
    }

    // Format content using formatters
    let content = formatResponse(newVersion.text || '', newVersion.thinkingText);

    // Append grounding if present
    if (newVersion.groundingData?.length) {
        content = appendGroundingToMessage(content, newVersion.groundingData);
    }

    // Append stopped marker if applicable
    if (newVersion.wasStoppedByUser) {
        content = content
            ? `${content}\n\n\\[stopped\\]`
            : '\\[stopped\\]';
    }

    // Handle empty response case
    if (!content && !newVersion.imageBase64) {
        content = '\\[Empty response\\]';
    }

    // Build version buttons for the last message
    const versionButtons = buildResponseButtons(
        ButtonState.HAS_VERSIONS,
        newIndex,
        versions.length
    );

    // Track new message IDs
    const newMessageIds: number[] = [firstMessageId];
    let currentMessageId = firstMessageId;

    // Get image from version's imageBase64 (preferred) or fallback to Message table
    let imageBuffer: Buffer | null = null;
    if (newVersion.imageBase64) {
        imageBuffer = Buffer.from(newVersion.imageBase64, 'base64');
    } else {
        // Fallback: try to load image from database for each extra message ID
        for (let i = 1; i < newVersion.messageIds.length; i++) {
            const msgId = newVersion.messageIds[i];
            if (msgId === undefined) continue;
            const msg = await getMessage(chatId, msgId);
            if (msg?.file) {
                imageBuffer = msg.file;
                break; // Only handle first image for now
            }
        }
    }

    // Handle content splitting if needed
    const hasImage = imageBuffer !== null;
    const needsTextSplit = needsSplit(content);

    /**
     * Helper to edit message with fallback on Markdown parse error
     */
    const editWithFallback = async (
        editor: MessageEditor,
        text: string,
        options?: { parseMode?: 'MarkdownV2'; replyMarkup?: any }
    ): Promise<boolean> => {
        const [editErr] = await to(editor.edit(text, options));
        if (editErr) {
            const errMsg = editErr.message || '';
            // If Markdown parse error, try with safe formatting
            if (errMsg.includes("can't parse entities")) {
                console.warn('[bot-message-service] Markdown parse error, retrying with safe formatting');
                let safeContent = formatResponseSafe(newVersion.text || '', newVersion.thinkingText);
                if (newVersion.groundingData?.length) {
                    safeContent = appendGroundingToMessage(safeContent, newVersion.groundingData);
                }
                if (newVersion.wasStoppedByUser) {
                    safeContent = safeContent ? `${safeContent}\n\n\\[stopped\\]` : '\\[stopped\\]';
                }
                if (!safeContent && !newVersion.imageBase64) {
                    safeContent = '\\[Empty response\\]';
                }
                const [retryErr] = await to(editor.edit(safeContent, options));
                if (retryErr) {
                    console.error('[bot-message-service] Safe formatting also failed:', retryErr);
                    return false;
                }
                return true;
            }
            console.error('[bot-message-service] Failed to edit message:', editErr);
            return false;
        }
        return true;
    };

    if (needsTextSplit) {
        const { currentPart, remaining } = smartSplit(content);

        // Edit first message with first part (no buttons - intermediate)
        const editor = createMessageEditor(ctx.api, chatId, firstMessageId);
        const success = await editWithFallback(editor, currentPart, { parseMode: 'MarkdownV2' });
        if (!success) {
            return false;
        }

        // Send remaining parts as continuation messages
        let remainingContent = remaining;
        while (remainingContent) {
            const split = smartSplit(remainingContent);
            const isLast = !split.remaining && !hasImage;

            const [sendErr, sentMsg] = await to(
                ctx.api.sendMessage(chatId, split.currentPart, {
                    parse_mode: 'MarkdownV2',
                    reply_parameters: { message_id: response.userMessageId },
                    // Only add buttons to the last message (if no image)
                    reply_markup: isLast ? versionButtons : undefined,
                })
            );

            if (sendErr) {
                console.error('[bot-message-service] Failed to send continuation:', sendErr);
                break;
            }

            newMessageIds.push(sentMsg.message_id);
            currentMessageId = sentMsg.message_id;
            remainingContent = split.remaining;
        }
    } else {
        // Single text message - edit (no buttons if there's an image coming)
        const editor = createMessageEditor(ctx.api, chatId, firstMessageId);
        const success = await editWithFallback(
            editor,
            content || '\\[Empty response\\]',
            {
                parseMode: 'MarkdownV2',
                replyMarkup: hasImage ? undefined : versionButtons,
            }
        );
        if (!success) {
            return false;
        }
    }

    // Send image if present (as last message with buttons)
    if (hasImage && imageBuffer) {
        const { InputFile } = await import('grammy');
        const [sendErr, sentMsg] = await to(
            ctx.api.sendPhoto(chatId, new InputFile(imageBuffer as any), {
                reply_parameters: { message_id: response.userMessageId },
                reply_markup: versionButtons,
            })
        );

        if (!sendErr) {
            newMessageIds.push(sentMsg.message_id);
            currentMessageId = sentMsg.message_id;
        } else {
            console.error('[bot-message-service] Failed to send image:', sendErr);
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
