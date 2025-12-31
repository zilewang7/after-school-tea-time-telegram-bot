/**
 * AI Response handler
 * Processes stream responses and updates Telegram messages
 */
import { match } from 'ts-pattern';
import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import { to, isErr } from '../shared/result';
import { formatErrorForUser } from '../shared/errors';
import {
    createSession,
    type BotMessageSession,
} from '../services';
import { buildResponseButtons } from '../cmd/menus';
import { ButtonState, type CommandType } from '../db';
import { isImageModel } from '../ai';
import { getCurrentModel } from '../state';
import {
    createTypingIndicator,
    createStreamingEditor,
    type StreamingEditor,
    type TypingIndicator,
} from '../telegram';
import {
    escapeMarkdownV2,
    formatResponse,
    toTelegramMarkdown,
    truncateForTelegram,
    formatThinkingContent,
} from '../telegram/formatters/markdown-formatter';
import { appendGroundingToMessage } from '../telegram/formatters/grounding-formatter';
import { smartSplit, needsSplit } from '../telegram/formatters/smart-splitter';
import type {
    StreamChunk,
    AIResponse,
    ResponseState,
} from '../ai/types';

// Message length limits for dynamic splitting
const MESSAGE_LENGTH_LIMIT = 3900;

/**
 * Chat context for response handling
 */
export interface ChatContext {
    ctx: Context;
    chatId: number;
    userMessageId: number;
    editor: StreamingEditor;
    typing: TypingIndicator;
    messageHistory: number[];  // All message IDs created for this response
    /** Current response state for idle updates */
    currentState?: ResponseState;
    /** Bot message session for lifecycle management */
    session: BotMessageSession;
    /** Current button state for maintaining buttons during edits */
    currentButtonState: ButtonState;
    /** Flag to prevent idle updates after finalization */
    isFinalized: boolean;
}

/**
 * Options for creating chat context
 */
export interface CreateChatContextOptions {
    /** Command type for retry routing */
    commandType?: CommandType;
}

/**
 * Create chat context from grammy context
 */
export const createChatContext = async (
    ctx: Context,
    options?: CreateChatContextOptions
): Promise<ChatContext | null> => {
    if (!ctx.message || !ctx.chat) return null;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Create typing indicator
    const typing = createTypingIndicator(ctx.api, chatId);
    typing.start();

    // Create bot message session (handles processing message creation)
    const session = await createSession(ctx, userMessageId, {
        commandType: options?.commandType,
    });
    if (!session) {
        typing.stop();
        console.error('[response-handler] Failed to create bot message session');
        return null;
    }

    // Create chat context
    const chatContext: ChatContext = {
        ctx,
        chatId,
        userMessageId,
        editor: null as any, // Will be set below
        typing,
        messageHistory: session.messageIds,
        currentState: undefined,
        session,
        currentButtonState: ButtonState.PROCESSING,
        isFinalized: false,
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking\\.\\.\\.', // Initial message content to avoid duplicate edits
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    chatContext.editor = editor;

    return chatContext;
};

/**
 * Process stream chunk and update state
 */
const processChunk = (chunk: StreamChunk, state: ResponseState): ResponseState => {
    return match(chunk)
        .with({ type: 'text' }, ({ content }) => ({
            ...state,
            textBuffer: state.textBuffer + (content ?? ''),
            fullText: state.fullText + (content ?? ''),
        }))
        .with({ type: 'thinking' }, ({ content }) => ({
            ...state,
            thinkingBuffer: state.thinkingBuffer + (content ?? ''),
            fullThinking: state.fullThinking + (content ?? ''),
        }))
        .with({ type: 'image' }, ({ imageData }) => ({
            ...state,
            images: imageData ? [...state.images, imageData] : state.images,
        }))
        .with({ type: 'grounding' }, ({ groundingMetadata }) => ({
            ...state,
            groundingData: groundingMetadata
                ? [...state.groundingData, groundingMetadata]
                : state.groundingData,
        }))
        .with({ type: 'done' }, ({ rawResponse }) => ({
            ...state,
            isDone: true,
            modelParts: (rawResponse as any)?.candidates?.[0]?.content?.parts,
        }))
        .exhaustive();
};

/**
 * Format current state for display (without status text - handled by StreamingEditor)
 */
const formatStateForDisplay = (
    state: ResponseState,
    isProcessing: boolean,
): string => {
    let display = '';

    if (state.thinkingBuffer) {
        if (!isProcessing) {
            // Use collapsed format for thinking
            display = formatThinkingContent(state.thinkingBuffer);
        } else {
            // Normal inline format
            display = '>' + state.thinkingBuffer.split('\n').map(escapeMarkdownV2).join('\n>');
        }

        if (state.textBuffer) {
            display += '\n';
        }
    }

    if (state.textBuffer) {
        if (!isProcessing) {
            display += toTelegramMarkdown(state.textBuffer)
        } else {
            display += escapeMarkdownV2(state.textBuffer);
        }
    }

    return display;
};

/**
 * Finalize current message during streaming (before switching to continuation)
 * Note: Database save is handled by session.finalize() at the end
 */
const finalizeCurrentMessage = async (
    chatContext: ChatContext,
    state: ResponseState,
): Promise<void> => {
    const { editor } = chatContext;

    // Stop the editor first to prevent any race conditions with idle updates
    editor.stop();

    // Format final content (with collapse if needed)
    const finalContent = formatStateForDisplay(state, false);

    // Update message with final content (no status text - isFinal)
    await editor.updateContent(finalContent, {
        parseMode: 'MarkdownV2',
        isFinal: true,
    });
};

/**
 * Create continuation message for long responses
 * Returns the new message ID
 */
const createContinuationMessage = async (
    chatContext: ChatContext
): Promise<number | null> => {
    const { ctx, chatId, userMessageId, session } = chatContext;

    // Build processing button for continuation
    const buttons = buildResponseButtons(chatContext.currentButtonState);

    // Create new processing message with button
    // Use a simple status placeholder - StreamingEditor will manage actual status
    const sendResult = await to(
        ctx.api.sendMessage(chatId, 'continued', {
            parse_mode: 'MarkdownV2',
            reply_parameters: { message_id: userMessageId },
            reply_markup: buttons,
        })
    );

    if (isErr(sendResult)) {
        console.error('[response-handler] Failed to create continuation message:', sendResult[0]);
        return null;
    }

    const newMessage = sendResult[1];
    chatContext.messageHistory.push(newMessage.message_id);

    // Create new StreamingEditor for the continuation message
    const newEditor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: newMessage.message_id,
        idleInterval: 2500,
        initialContent: 'continued',
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    // Replace the editor in context
    chatContext.editor = newEditor;

    return newMessage.message_id;
};

/**
 * Process AI stream and update message in real-time
 */
export const processStream = async (
    stream: AsyncIterable<StreamChunk>,
    chatContext: ChatContext,
    updateInterval: number = 500
): Promise<AIResponse> => {
    const { session } = chatContext;

    let state: ResponseState = {
        textBuffer: '',
        thinkingBuffer: '',
        fullText: '',
        fullThinking: '',
        images: [],
        groundingData: [],
        modelParts: undefined,
        isDone: false,
    };

    let lastUpdateTime = Date.now();

    for await (const chunk of stream) {
        // Check if stream was aborted (user clicked stop)
        if (session.streamController.isAborted()) {
            console.log('[response-handler] Stream aborted by user');
            break;
        }

        state = processChunk(chunk, state);

        // Sync complete text to session buffers (not the display buffers)
        session.textBuffer = state.fullText;
        session.thinkingBuffer = state.fullThinking;
        session.images = state.images;
        session.groundingData = state.groundingData;

        // Update current state for idle updates
        chatContext.currentState = state;

        // Format current display (without status - StreamingEditor handles it)
        const displayText = formatStateForDisplay(state, true);

        // Check if we need to switch to a new message
        // Add some buffer for status text that will be appended
        if (displayText.length >= MESSAGE_LENGTH_LIMIT - 50) {
            console.log('[response-handler] Message length exceeded, switching to continuation...');

            let thinkingToSend = state.thinkingBuffer;
            let remainingThinking = '';
            let textToSend = state.textBuffer;
            let remainingText = '';

            // Calculate thinking formatted length
            const thinkingFormatted = state.thinkingBuffer
                ? '>' + state.thinkingBuffer.split('\n').map(escapeMarkdownV2).join('\n>')
                : '';

            // Case 1: Thinking itself is too long
            if (thinkingFormatted.length >= MESSAGE_LENGTH_LIMIT - 100) {
                console.log('[response-handler] Thinking itself exceeds limit, splitting thinking...');
                // Need to split thinking at newline
                const { currentPart, remaining } = smartSplit(
                    state.thinkingBuffer,
                    Math.floor((MESSAGE_LENGTH_LIMIT - 100) / 1.2) // Conservative estimate for escaped length
                );
                thinkingToSend = currentPart;
                remainingThinking = remaining;
                textToSend = ''; // Can't send any text in this message
                remainingText = state.textBuffer; // Keep all text for next message
            } else {
                // Case 2: Thinking fits, but thinking + text is too long
                const newlineSpace = state.thinkingBuffer ? 1 : 0; // Newline between thinking and text
                const availableSpace = MESSAGE_LENGTH_LIMIT - thinkingFormatted.length - newlineSpace - 100;

                if (state.textBuffer) {
                    const escapedText = escapeMarkdownV2(state.textBuffer);
                    if (escapedText.length > availableSpace) {
                        // Need to split text at newline
                        const { currentPart, remaining } = smartSplit(
                            state.textBuffer,
                            Math.floor(availableSpace / 1.5) // Conservative estimate
                        );
                        textToSend = currentPart;
                        remainingText = remaining;
                    }
                }
            }

            // Finalize current message with what we can send
            await finalizeCurrentMessage(chatContext, {
                ...state,
                thinkingBuffer: thinkingToSend,
                textBuffer: textToSend,
            });

            // Create continuation message (also switches editor to new message)
            const newMessageId = await createContinuationMessage(chatContext);
            if (!newMessageId) {
                console.error('[response-handler] Failed to create continuation message, stopping stream');
                break;
            }

            // Update state with remaining content
            state.thinkingBuffer = remainingThinking; // May have remaining thinking
            state.textBuffer = remainingText; // Keep remaining text

            // Reset last update time
            lastUpdateTime = Date.now();
            continue;
        }

        // Update message periodically
        const shouldUpdate =
            (state.textBuffer || state.thinkingBuffer) &&
            Date.now() - lastUpdateTime > updateInterval;

        if (shouldUpdate) {
            const buttons = buildResponseButtons(chatContext.currentButtonState);
            await chatContext.editor.updateContent(displayText, {
                parseMode: 'MarkdownV2',
                replyMarkup: buttons,
            });
            lastUpdateTime = Date.now();
        }
    }

    return {
        text: state.textBuffer,
        thinkingText: state.thinkingBuffer,
        images: state.images,
        groundingData: state.groundingData,
        modelParts: state.modelParts,
    };
};

/**
 * Send final response (text and/or images)
 * Handles the last message in the chain (may be first or continuation)
 */
export const sendFinalResponse = async (
    chatContext: ChatContext,
    response: AIResponse
): Promise<void> => {
    // Immediately mark as finalized to prevent race conditions with idle updates
    chatContext.isFinalized = true;

    const { ctx, chatId, userMessageId, editor, typing, session } = chatContext;

    typing.stop();
    editor.stop();

    // Check if stopped by user
    const wasStoppedByUser = session.streamController.isAborted();

    let finalMessage = formatResponse(response.text, response.thinkingText)

    // Add [stopped] marker if stopped by user (after formatting)
    if (wasStoppedByUser) {
        finalMessage = finalMessage
            ? `${finalMessage}\n\n\\[stopped\\]`
            : '\\[stopped\\]';
    }

    // Append grounding metadata if present
    if (response.groundingData?.length) {
        finalMessage = appendGroundingToMessage(finalMessage, response.groundingData);
        console.log('[response-handler] Grounding metadata:', JSON.stringify(response.groundingData));
    }

    // Set raw parts for fallback formatting on parse error
    editor.setRawParts({
        text: response.text,
        thinking: response.thinkingText,
        groundingData: response.groundingData,
    });

    // Check if final message (with grounding) exceeds limit
    if (needsSplit(finalMessage)) {
        console.log('[response-handler] Final message with grounding exceeds limit, splitting...');

        const { currentPart, remaining } = smartSplit(finalMessage);

        // Send current part first (no buttons on split messages)
        // Note: rawParts won't help here since message is already split
        await editor.updateContent(currentPart, { parseMode: 'MarkdownV2', isFinal: true });

        // Send remaining as continuation
        if (remaining) {
            const continuationResult = await to(
                ctx.api.sendMessage(chatId, remaining, {
                    parse_mode: 'MarkdownV2',
                    reply_parameters: { message_id: userMessageId },
                })
            );

            if (!isErr(continuationResult)) {
                const contMsg = continuationResult[1];
                chatContext.messageHistory.push(contMsg.message_id);
                session.messageIds.push(contMsg.message_id);
                session.currentMessageId = contMsg.message_id;
            }
        }

        // Send image if present (after text split)
        const hasImages = response.images.length > 0;
        if (hasImages) {
            const photoBuffer = response.images[0];
            if (photoBuffer) {
                const sendResult = await to(
                    ctx.api.sendPhoto(chatId, new InputFile(photoBuffer as unknown as ConstructorParameters<typeof InputFile>[0]), {
                        reply_parameters: { message_id: userMessageId },
                    })
                );

                if (!isErr(sendResult)) {
                    const sentMsg = sendResult[1];
                    chatContext.messageHistory.push(sentMsg.message_id);
                    session.messageIds.push(sentMsg.message_id);
                    session.currentMessageId = sentMsg.message_id;
                }
            }
        }

        // Finalize session (saves to both Message and BotResponse tables)
        await session.finalize({ modelParts: response.modelParts, wasStoppedByUser });

        // Add buttons to the last message after finalization
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        const finalButtonState = botResponse?.buttonState ?? ButtonState.NONE;

        if (finalButtonState !== ButtonState.NONE) {
            const finalButtons = buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1
            );

            const [editErr] = await to(
                ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                    reply_markup: finalButtons,
                })
            );
            if (editErr) {
                console.error('[response-handler] Failed to add buttons to split message:', editErr);
            }
        }
        return;
    }

    const hasText = Boolean(finalMessage);
    const hasImages = response.images.length > 0;

    // Check if this is an image generation context (picbanana command OR image model)
    const currentModel = getCurrentModel();
    const isImageGenerationContext = isImageModel(currentModel);
    const noImageInResponse = isImageGenerationContext && !hasImages && !wasStoppedByUser;

    // Add [no image in response] marker for image generation without images
    if (noImageInResponse) {
        finalMessage = finalMessage
            ? `${finalMessage}\n\n\\[no image in response\\]`
            : '\\[no image in response\\]';
    }

    console.log('[response-handler] Final response:', {
        hasText,
        hasImages,
        imageCount: response.images.length,
        textLength: response.text.length,
        thinkingLength: response.thinkingText.length,
        messageCount: chatContext.messageHistory.length,
        wasStoppedByUser,
        isImageGenerationContext,
        noImageInResponse,
    });

    if (hasImages) {
        // Update text message first (no buttons - intermediate message)
        if (hasText) {
            await editor.updateContent(finalMessage, { parseMode: 'MarkdownV2', isFinal: true });
        } else {
            // No text, delete the processing message
            await editor.delete();
            session.messageIds = session.messageIds.filter(id => id !== session.firstMessageId);
        }

        // Send image as last message (buttons will be added after finalize)
        const photoBuffer = response.images[0];
        if (photoBuffer) {
            const sendResult = await to(
                ctx.api.sendPhoto(chatId, new InputFile(photoBuffer as any), {
                    reply_parameters: { message_id: userMessageId },
                })
            );

            if (!isErr(sendResult)) {
                const sentMsg = sendResult[1];
                chatContext.messageHistory.push(sentMsg.message_id);
                session.messageIds.push(sentMsg.message_id);
                session.currentMessageId = sentMsg.message_id;
            }
        }

        // Finalize session AFTER sending all messages (so image message ID is included)
        await session.finalize({ modelParts: response.modelParts, wasStoppedByUser });

        // Get the correct button state after finalization and update the last message
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        const finalButtonState = botResponse?.buttonState ?? ButtonState.NONE;

        if (finalButtonState !== ButtonState.NONE) {
            const finalButtons = buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1
            );

            // Edit the last message (image) to add buttons
            const [editErr] = await to(
                ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                    reply_markup: finalButtons,
                })
            );
            if (editErr) {
                console.error('[response-handler] Failed to add buttons to image:', editErr);
            }
        }
    } else {
        // Finalize session first to determine button state (no image case)
        await session.finalize({ modelParts: response.modelParts, wasStoppedByUser });

        // Get the correct button state after finalization
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        // For image generation without images: ensure at least RETRY_ONLY, but keep HAS_VERSIONS if already set
        const dbButtonState = botResponse?.buttonState ?? ButtonState.NONE;
        const finalButtonState = noImageInResponse && dbButtonState === ButtonState.NONE
            ? ButtonState.RETRY_ONLY
            : dbButtonState;
        const finalButtons = finalButtonState !== ButtonState.NONE
            ? buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1
            )
            : undefined;

        if (hasText || wasStoppedByUser || noImageInResponse) {
            // Text response, stopped, or no image in image generation context
            const displayMessage = finalMessage || '\\[stopped\\]';
            await editor.updateContent(displayMessage, {
                parseMode: 'MarkdownV2',
                replyMarkup: finalButtons,
                isFinal: true,
            });
        } else {
            // No content and not stopped - show error
            const fallbackMessage = '寄了';
            await editor.updateContent(fallbackMessage, { replyMarkup: finalButtons, isFinal: true });
        }
    }
};

/**
 * Handle error during response processing
 */
export const handleResponseError = async (
    chatContext: ChatContext,
    error: Error,
    partialText?: string
): Promise<void> => {
    // Check if this is an abort (user clicked stop)
    const isAborted = error.message === 'Aborted' || chatContext.session.streamController.isAborted();

    if (isAborted) {
        // Treat abort as normal stop, not error
        // Build response from current state
        const response = {
            text: chatContext.currentState?.textBuffer || '',
            thinkingText: chatContext.currentState?.thinkingBuffer || '',
            images: chatContext.currentState?.images || [],
            groundingData: chatContext.currentState?.groundingData || [],
            modelParts: chatContext.currentState?.modelParts,
        };

        // Use normal final response flow with stopped flag
        await sendFinalResponse(chatContext, response);
        return;
    }

    // Immediately mark as finalized to prevent race conditions with idle updates
    chatContext.isFinalized = true;

    const { chatId, editor, typing, session } = chatContext;

    typing.stop();
    editor.stop();

    // Finalize session with error first to set buttonState
    await session.handleError(error);

    // Format and display error
    const errorMessage = formatErrorForUser(error, partialText ? undefined : '错误');
    const displayMessage = partialText
        ? `${partialText}\n\n${errorMessage}`
        : errorMessage;

    const truncatedMessage = truncateForTelegram(displayMessage);

    // Get the correct button state after finalization (may be HAS_VERSIONS for retry errors)
    const getBotResponseForButtons = async () => {
        const { getBotResponse } = await import('../db');
        return getBotResponse(chatId, session.firstMessageId);
    };
    const botResponse = await getBotResponseForButtons();
    // Always show at least RETRY_ONLY for errors
    const finalButtonState = botResponse?.buttonState === ButtonState.NONE
        ? ButtonState.RETRY_ONLY
        : (botResponse?.buttonState ?? ButtonState.RETRY_ONLY);
    const errorButtons = buildResponseButtons(
        finalButtonState,
        botResponse?.currentVersionIndex ?? 0,
        botResponse?.getVersions().length ?? 1
    );

    // Edit with retry button
    const editResult = await to(
        editor.updateContent(truncatedMessage, { replyMarkup: errorButtons, isFinal: true })
    );

    if (isErr(editResult)) {
        console.error('[response-handler] Failed to edit error message:', editResult[0]);
        // Retry after delay
        setTimeout(async () => {
            await editor.updateContent(truncatedMessage, { replyMarkup: errorButtons, isFinal: true });
        }, 15000);
    } else {
        console.error('[response-handler]', error);
    }
};

/**
 * Create chat context for retry from existing session
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
export const createChatContextForRetry = (
    ctx: Context,
    session: BotMessageSession
): ChatContext => {
    const chatId = session.chatId;

    // Create typing indicator
    const typing = createTypingIndicator(ctx.api, chatId);
    typing.start();

    // Create chat context
    const chatContext: ChatContext = {
        ctx,
        chatId,
        userMessageId: session.userMessageId,
        editor: null as any, // Will be set below
        typing,
        messageHistory: session.messageIds,
        currentState: undefined,
        session,
        currentButtonState: ButtonState.PROCESSING,
        isFinalized: false,
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking\\.\\.\\.', // Initial message content to avoid duplicate edits
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    chatContext.editor = editor;

    return chatContext;
};
