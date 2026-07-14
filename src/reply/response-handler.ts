/**
 * AI Response handler
 * Processes stream responses and updates Telegram messages
 */
import { match } from 'ts-pattern';
import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import { to, isErr } from '../shared/result.js';
import { formatErrorForUser } from '../shared/errors.js';
import {
    createSession,
    type BotMessageSession,
} from '../services/index.js';
import { buildResponseButtons } from '../cmd/menus/index.js';
import { ButtonState, type CommandType } from '../db/index.js';

import {
    createTypingIndicator,
    createStreamingEditor,
    type StreamingEditor,
    type TypingIndicator,
} from '../telegram/index.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { registerContinuation } from '../state.js';
import {
    concatMessages,
    renderMarkdown,
    wrapInBlockquote,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import { truncateForTelegram } from '../telegram/formatters/text-utils.js';
import { buildFinalMessages } from '../telegram/formatters/final-message-builder.js';
import { splitRawByFits, splitAtLastNewline } from '../telegram/formatters/smart-splitter.js';
import type {
    StreamChunk,
    AIResponse,
    ResponseState,
} from '../ai/types.js';

const MESSAGE_LENGTH_LIMIT = 3900;
/** Per-message entity budget during streaming (server cap is ~100; the
 *  final pass re-renders per message so a little headroom is enough) */
const MESSAGE_ENTITY_LIMIT = 85;
const THINKING_BUFFER_LIMIT = 10000;
/** Below this remaining budget, move the whole text to the continuation
 *  instead of squeezing a tiny tail that would be chopped mid-sentence */
const MIN_TAIL_TEXT_BUDGET = 500;

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
    /** Command type for image generation context detection and retry routing */
    commandType: CommandType;
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
        commandType: options?.commandType ?? 'chat',
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking...', // Initial message content to avoid duplicate edits
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
        .with({ type: 'thinking' }, ({ content }) => {
            const appended = content ?? '';
            let newThinkingBuffer = state.thinkingBuffer + appended;
            let newFullThinking = state.fullThinking + appended;
            let truncatedChars = state.thinkingTruncatedChars;

            if (newThinkingBuffer.length > THINKING_BUFFER_LIMIT) {
                truncatedChars += newThinkingBuffer.length;
                const placeholder = `[reasoning truncated, ${truncatedChars} chars omitted to avoid telegram flood]\n`;
                newThinkingBuffer = placeholder;
                newFullThinking = placeholder;
            }

            return {
                ...state,
                thinkingBuffer: newThinkingBuffer,
                fullThinking: newFullThinking,
                thinkingTruncatedChars: truncatedChars,
            };
        })
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
        .with({ type: 'done' }, ({ rawResponse, agentStats }) => {
            const finalOutputText = (rawResponse as any)?.output_text;
            const canSafelyReplaceBufferedText =
                typeof finalOutputText === 'string' && state.fullText === state.textBuffer;

            return {
                ...state,
                agentStats: agentStats ?? state.agentStats,
                textBuffer: canSafelyReplaceBufferedText ? finalOutputText : state.textBuffer,
                fullText: canSafelyReplaceBufferedText ? finalOutputText : state.fullText,
                isDone: true,
                modelParts: (rawResponse as any)?.candidates?.[0]?.content?.parts,
                rawResponse,
            };
        })
        .exhaustive();
};

/**
 * Format current state for display (without status text - handled by
 * StreamingEditor). While processing, markdown renders in streaming mode
 * (unclosed constructs show as their intended formatting) and thinking is a
 * plain blockquote; the final pass renders strict and collapses thinking.
 */
const formatStateForDisplay = (
    state: ResponseState,
    isProcessing: boolean,
): RenderedMessage => {
    const parts: (RenderedMessage | string)[] = [];

    if (state.thinkingBuffer) {
        parts.push(
            wrapInBlockquote(
                renderMarkdown(state.thinkingBuffer, { streaming: isProcessing }),
                !isProcessing
            )
        );
        if (state.textBuffer) {
            parts.push('\n');
        }
    }

    if (state.textBuffer) {
        parts.push(renderMarkdown(state.textBuffer, { streaming: isProcessing }));
    }

    return concatMessages(...parts);
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
    await editor.updateContent(finalContent.text, {
        entities: finalContent.entities,
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
        runApiCall(chatId, () =>
            ctx.api.sendMessage(chatId, 'continued', {
                reply_parameters: { message_id: userMessageId },
                reply_markup: buttons,
            })
        )
    );

    if (isErr(sendResult)) {
        console.error('[response-handler] Failed to create continuation message:', sendResult[0]);
        return null;
    }

    const newMessage = sendResult[1];
    chatContext.messageHistory.push(newMessage.message_id);
    registerContinuation(chatId, newMessage.message_id, session.firstMessageId);

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
        thinkingTruncatedChars: 0,
        images: [],
        groundingData: [],
        agentStats: undefined,
        modelParts: undefined,
        rawResponse: undefined,
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
        session.agentStats = state.agentStats;

        // Update current state for idle updates
        chatContext.currentState = state;

        // Format current display (without status - StreamingEditor handles it)
        const rendered = formatStateForDisplay(state, true);

        // Check if we need to switch to a new message: both budgets matter —
        // some buffer for the status text; entities past ~100 are dropped
        if (
            rendered.text.length >= MESSAGE_LENGTH_LIMIT - 50 ||
            rendered.entities.length >= MESSAGE_ENTITY_LIMIT
        ) {
            console.log('[response-handler] Message budget exceeded, switching to continuation...');

            let thinkingToSend = state.thinkingBuffer;
            let remainingThinking = '';
            let textToSend = state.textBuffer;
            let remainingText = '';

            // Renderer used for thinking in the streaming (processing) view
            const renderThinkingForStreaming = (thinking: string): RenderedMessage =>
                wrapInBlockquote(renderMarkdown(thinking, { streaming: true }), false);

            const thinkingRendered = state.thinkingBuffer
                ? renderThinkingForStreaming(state.thinkingBuffer)
                : concatMessages();

            // Case 1: Thinking alone can't fit in one message
            if (
                thinkingRendered.text.length >= MESSAGE_LENGTH_LIMIT ||
                thinkingRendered.entities.length >= MESSAGE_ENTITY_LIMIT
            ) {
                console.log('[response-handler] Thinking itself exceeds limit, splitting thinking...');
                // Exact-measure split: keeps everything already displayed
                const { currentPart, remaining } = splitRawByFits(
                    state.thinkingBuffer,
                    (prefix) => {
                        const measured = renderThinkingForStreaming(prefix);
                        return (
                            measured.text.length <= MESSAGE_LENGTH_LIMIT &&
                            measured.entities.length <= MESSAGE_ENTITY_LIMIT
                        );
                    }
                );
                thinkingToSend = currentPart;
                remainingThinking = remaining;
                textToSend = ''; // Can't send any text in this message
                remainingText = state.textBuffer; // Keep all text for next message
            } else {
                // Case 2: Thinking fits, but thinking + text is too long
                const newlineSpace = state.thinkingBuffer ? 1 : 0; // Newline between thinking and text
                const availableSpace = MESSAGE_LENGTH_LIMIT - thinkingRendered.text.length - newlineSpace;
                const availableEntities = MESSAGE_ENTITY_LIMIT - thinkingRendered.entities.length;
                const textFits = (prefix: string): boolean => {
                    const measured = renderMarkdown(prefix, { streaming: true });
                    return (
                        measured.text.length <= availableSpace &&
                        measured.entities.length <= availableEntities
                    );
                };

                if (state.textBuffer) {
                    if (availableSpace < MIN_TAIL_TEXT_BUDGET) {
                        // Thinking ate the budget: don't close this message with
                        // a tiny text tail (even one that currently fits) —
                        // start the text cleanly in the next message
                        textToSend = '';
                        remainingText = state.textBuffer;
                    } else if (!textFits(state.textBuffer)) {
                        // Exact-measure split, preferring paragraph/newline boundaries
                        const { currentPart, remaining } = splitRawByFits(
                            state.textBuffer,
                            textFits
                        );
                        textToSend = currentPart;
                        remainingText = remaining;
                    } else {
                        // Text fits, but the message is closing mid-stream: end
                        // it at a paragraph/newline instead of wherever the last
                        // stream chunk happened to land
                        const { currentPart, remaining } = splitAtLastNewline(
                            state.textBuffer,
                            Math.floor(state.textBuffer.length / 4)
                        );
                        // Without thinking to carry the message, keep everything
                        // rather than finalizing a near-empty message
                        if (currentPart || state.thinkingBuffer) {
                            textToSend = currentPart;
                            remainingText = remaining;
                        }
                    }
                } else if (state.thinkingBuffer) {
                    // Thinking-only message closing mid-stream: same rule, end
                    // at a line boundary (keep whole when none qualifies)
                    const { currentPart, remaining } = splitAtLastNewline(
                        state.thinkingBuffer,
                        Math.floor(state.thinkingBuffer.length / 4)
                    );
                    if (currentPart) {
                        thinkingToSend = currentPart;
                        remainingThinking = remaining;
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
            await chatContext.editor.updateContent(rendered.text, {
                entities: rendered.entities,
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
        agentStats: state.agentStats,
        modelParts: state.modelParts,
        rawResponse: state.rawResponse,
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

    const finalChunks = buildFinalMessages({
        text: response.text,
        thinking: response.thinkingText,
        agentStats: response.agentStats,
        wasStoppedByUser,
        groundingData: response.groundingData,
    });
    let finalMessage: RenderedMessage = finalChunks[0] ?? { text: '', entities: [] };

    if (response.groundingData?.length) {
        console.log('[response-handler] Grounding metadata:', JSON.stringify(response.groundingData));
    }

    // Check if final message needs multi-message output
    if (finalChunks.length > 1) {
        console.log('[response-handler] Final message exceeds limit, splitting by sections...');

        // Send current part first (no buttons on split messages)
        await editor.updateContent(finalMessage.text, {
            entities: finalMessage.entities,
            isFinal: true,
        });

        for (const chunk of finalChunks.slice(1)) {
            const continuationResult = await to(
                runApiCall(chatId, () =>
                    ctx.api.sendMessage(chatId, chunk.text, {
                        entities: toApiEntities(chunk.entities),
                        reply_parameters: { message_id: userMessageId },
                    })
                )
            );

            if (isErr(continuationResult)) {
                console.error('[response-handler] Failed to send continuation:', continuationResult[0]);
                break;
            }

            const contMsg = continuationResult[1];
            chatContext.messageHistory.push(contMsg.message_id);
            session.messageIds.push(contMsg.message_id);
            session.currentMessageId = contMsg.message_id;
        }

        // Send image if present (after text split)
        const hasImages = response.images.length > 0;
        if (hasImages) {
            const photoBuffer = response.images[0];
            if (photoBuffer) {
                console.log('[response-handler] Sending photo (split path):', { bufferSize: photoBuffer.length, chatId });
                const sendResult = await to(
                    runApiCall(chatId, () =>
                        ctx.api.sendPhoto(chatId, new InputFile(photoBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png'), {
                            reply_parameters: { message_id: userMessageId },
                        })
                    )
                );

                if (!isErr(sendResult)) {
                    const sentMsg = sendResult[1];
                    chatContext.messageHistory.push(sentMsg.message_id);
                    session.messageIds.push(sentMsg.message_id);
                    session.currentMessageId = sentMsg.message_id;
                } else {
                    console.error('[response-handler] sendPhoto failed (split path):', sendResult[0].message);
                    const docFile = new InputFile(photoBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png');
                    const docResult = await to(
                        runApiCall(chatId, () =>
                            ctx.api.sendDocument(chatId, docFile, {
                                reply_parameters: { message_id: userMessageId },
                            })
                        )
                    );
                    if (!isErr(docResult)) {
                        const sentMsg = docResult[1];
                        chatContext.messageHistory.push(sentMsg.message_id);
                        session.messageIds.push(sentMsg.message_id);
                        session.currentMessageId = sentMsg.message_id;
                    } else {
                        console.error('[response-handler] sendDocument also failed (split path):', docResult[0]);
                    }
                }
            }
        }

        // Finalize session (saves to both Message and BotResponse tables)
        await session.finalize({ modelParts: response.modelParts, wasStoppedByUser });

        // Add buttons to the last message after finalization
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db/index.js');
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
                runApiCall(chatId, () =>
                    ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                        reply_markup: finalButtons,
                    })
                )
            );
            if (editErr) {
                console.error('[response-handler] Failed to add buttons to split message:', editErr);
            }
        }
        return;
    }

    const hasText = Boolean(finalMessage.text);
    const hasImages = response.images.length > 0;

    // Check if this is an image generation context
    const isImageGenerationContext = chatContext.commandType === 'picbanana'
        || chatContext.commandType === 'picgpt';
    const noImageInResponse = isImageGenerationContext && !hasImages && !wasStoppedByUser;

    // Add [no image in response] marker for image generation without images
    if (noImageInResponse) {
        finalMessage = concatMessages(
            finalMessage,
            finalMessage.text ? '\n\n[no image in response]' : '[no image in response]'
        );
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
            await editor.updateContent(finalMessage.text, {
                entities: finalMessage.entities,
                isFinal: true,
            });
        } else {
            // No text, delete the processing message
            await editor.delete();
            session.messageIds = session.messageIds.filter(id => id !== session.firstMessageId);
        }

        // Send image as last message (buttons will be added after finalize)
        const photoBuffer = response.images[0];
        if (photoBuffer) {
            console.log('[response-handler] Sending photo:', { bufferSize: photoBuffer.length, chatId, replyTo: userMessageId });
            const inputFile = new InputFile(photoBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png');

            // Try sendPhoto first, fallback to sendDocument if Telegram rejects the format
            const sendResult = await to(
                runApiCall(chatId, () =>
                    ctx.api.sendPhoto(chatId, inputFile, {
                        reply_parameters: { message_id: userMessageId },
                    })
                )
            );

            if (!isErr(sendResult)) {
                const sentMsg = sendResult[1];
                chatContext.messageHistory.push(sentMsg.message_id);
                session.messageIds.push(sentMsg.message_id);
                session.currentMessageId = sentMsg.message_id;
            } else {
                console.warn('[response-handler] sendPhoto failed, fallback to sendDocument:', sendResult[0].message);
                const docFile = new InputFile(photoBuffer as unknown as ConstructorParameters<typeof InputFile>[0], 'image.png');
                const docResult = await to(
                    runApiCall(chatId, () =>
                        ctx.api.sendDocument(chatId, docFile, {
                            reply_parameters: { message_id: userMessageId },
                        })
                    )
                );
                if (!isErr(docResult)) {
                    const sentMsg = docResult[1];
                    chatContext.messageHistory.push(sentMsg.message_id);
                    session.messageIds.push(sentMsg.message_id);
                    session.currentMessageId = sentMsg.message_id;
                } else {
                    console.error('[response-handler] sendDocument also failed:', docResult[0]);
                }
            }
        }

        // Finalize session AFTER sending all messages (so image message ID is included)
        await session.finalize({ modelParts: response.modelParts, wasStoppedByUser });

        // Get the correct button state after finalization and update the last message
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db/index.js');
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
                runApiCall(chatId, () =>
                    ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                        reply_markup: finalButtons,
                    })
                )
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
            const { getBotResponse } = await import('../db/index.js');
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
            const displayMessage: RenderedMessage = finalMessage.text
                ? finalMessage
                : { text: '[stopped]', entities: [] };
            await editor.updateContent(displayMessage.text, {
                entities: displayMessage.entities,
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
            agentStats: chatContext.currentState?.agentStats,
            modelParts: chatContext.currentState?.modelParts,
            rawResponse: chatContext.currentState?.rawResponse,
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

    // Lenient markdown render: partial text keeps its formatting, and error
    // text can never produce a parse failure on the entities path
    const errorRendered = renderMarkdown(truncateForTelegram(displayMessage));

    // Get the correct button state after finalization (may be HAS_VERSIONS for retry errors)
    const getBotResponseForButtons = async () => {
        const { getBotResponse } = await import('../db/index.js');
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

    // Edit with retry button (delivery retries handled by the edit coordinator)
    const delivered = await editor.updateContent(errorRendered.text, {
        entities: errorRendered.entities,
        replyMarkup: errorButtons,
        isFinal: true,
    });
    if (!delivered) {
        console.error('[response-handler] Failed to edit error message');
    }
    console.error('[response-handler]', error);
};

/**
 * Create chat context for retry from existing session
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
export const createChatContextForRetry = (
    ctx: Context,
    session: BotMessageSession,
    commandType: CommandType = 'chat'
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
        commandType,
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking...', // Initial message content to avoid duplicate edits
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
