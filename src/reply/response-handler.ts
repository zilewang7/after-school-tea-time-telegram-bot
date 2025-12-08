/**
 * AI Response handler
 * Processes stream responses and updates Telegram messages
 */
import { match } from 'ts-pattern';
import type { Context } from 'grammy';
import type { Menu } from '@grammyjs/menu';
import { InputFile } from 'grammy';
import { to, isErr } from '../shared/result';
import { formatErrorForUser } from '../shared/errors';
import { saveMessage } from '../db';
import {
    createTypingIndicator,
    createMessageEditor,
    type MessageEditor,
    type TypingIndicator,
} from '../telegram';
import {
    escapeMarkdownV2,
    formatResponse,
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

const botUserId = Number(process.env.BOT_USER_ID);
const botUserName = process.env.BOT_NAME;

// Message length limits for dynamic splitting
const MESSAGE_LENGTH_LIMIT = 3900;

/**
 * Chat context for response handling
 */
export interface ChatContext {
    ctx: Context;
    chatId: number;
    userMessageId: number;
    editor: MessageEditor;
    typing: TypingIndicator;
    retryMenu: Menu<Context>;
    messageHistory: number[];  // All message IDs created for this response
}

/**
 * Create chat context from grammy context
 */
export const createChatContext = async (
    ctx: Context,
    retryMenu: Menu<Context>
): Promise<ChatContext | null> => {
    if (!ctx.message || !ctx.chat) return null;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Create typing indicator
    const typing = createTypingIndicator(ctx.api, chatId);
    typing.start();

    // Create processing message
    const processingResult = await to(
        ctx.reply('Processing...', {
            reply_parameters: { message_id: userMessageId },
        })
    );

    if (isErr(processingResult)) {
        typing.stop();
        console.error('[response-handler] Failed to create processing message:', processingResult[0]);
        return null;
    }
    const processingMsg = processingResult[1];

    const editor = createMessageEditor(ctx.api, chatId, processingMsg.message_id);

    return {
        ctx,
        chatId,
        userMessageId,
        editor,
        typing,
        retryMenu,
        messageHistory: [processingMsg.message_id],
    };
};

/**
 * Process stream chunk and update state
 */
const processChunk = (chunk: StreamChunk, state: ResponseState): ResponseState => {
    return match(chunk)
        .with({ type: 'text' }, ({ content }) => ({
            ...state,
            textBuffer: state.textBuffer + (content ?? ''),
        }))
        .with({ type: 'thinking' }, ({ content }) => ({
            ...state,
            thinkingBuffer: state.thinkingBuffer + (content ?? ''),
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
 * Format current state for display
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
        display += escapeMarkdownV2(state.textBuffer);
    }

    if (isProcessing && display) {
        display += '\nProcessing\\.\\.\\.';
    }

    return display || 'Processing...';
};

/**
 * Finalize current message and save to database
 */
const finalizeCurrentMessage = async (
    chatContext: ChatContext,
    state: ResponseState,
): Promise<void> => {
    const { chatId, userMessageId, editor } = chatContext;
    const { messageId } = editor.getIds();

    // Format final content (with collapse if needed)
    const finalContent = formatStateForDisplay(state, false);

    // Update message with final content
    await editor.edit(finalContent, { parseMode: 'MarkdownV2' });

    // Save to database
    await saveMessage({
        chatId,
        messageId,
        userId: botUserId,
        date: new Date(),
        userName: botUserName,
        message: state.textBuffer || (state.thinkingBuffer ? '[Thinking]' : ''),
        replyToId: userMessageId,
    });
};

/**
 * Create continuation message for long responses
 */
const createContinuationMessage = async (
    chatContext: ChatContext
): Promise<MessageEditor | null> => {
    const { ctx, chatId, userMessageId } = chatContext;

    // Create new processing message
    const sendResult = await to(
        ctx.api.sendMessage(chatId, '_\\(continued\\)_\nProcessing\\.\\.\\.', {
            parse_mode: 'MarkdownV2',
            reply_parameters: { message_id: userMessageId },
        })
    );

    if (isErr(sendResult)) {
        console.error('[response-handler] Failed to create continuation message:', sendResult[0]);
        return null;
    }

    const newMessage = sendResult[1];
    chatContext.messageHistory.push(newMessage.message_id);

    return createMessageEditor(ctx.api, chatId, newMessage.message_id);
};

/**
 * Process AI stream and update message in real-time
 */
export const processStream = async (
    stream: AsyncIterable<StreamChunk>,
    chatContext: ChatContext,
    updateInterval: number = 500
): Promise<AIResponse> => {
    let state: ResponseState = {
        textBuffer: '',
        thinkingBuffer: '',
        images: [],
        groundingData: [],
        modelParts: undefined,
        isDone: false,
    };

    let lastUpdateTime = Date.now();

    for await (const chunk of stream) {
        state = processChunk(chunk, state);

        // Format current display
        const displayText = formatStateForDisplay(state, true);

        // Check if we need to switch to a new message
        if (displayText.length >= MESSAGE_LENGTH_LIMIT) {
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
            if (thinkingFormatted.length >= MESSAGE_LENGTH_LIMIT - 20) {
                console.log('[response-handler] Thinking itself exceeds limit, splitting thinking...');
                // Need to split thinking at newline
                const { currentPart, remaining } = smartSplit(
                    state.thinkingBuffer,
                    Math.floor((MESSAGE_LENGTH_LIMIT - 20) / 1.2) // Conservative estimate for escaped length
                );
                thinkingToSend = currentPart;
                remainingThinking = remaining;
                textToSend = ''; // Can't send any text in this message
                remainingText = state.textBuffer; // Keep all text for next message
            } else {
                // Case 2: Thinking fits, but thinking + text is too long
                const newlineSpace = state.thinkingBuffer ? 1 : 0; // Newline between thinking and text
                const availableSpace = MESSAGE_LENGTH_LIMIT - thinkingFormatted.length - newlineSpace - 20;

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

            // Create continuation message
            const newEditor = await createContinuationMessage(chatContext);
            if (!newEditor) {
                console.error('[response-handler] Failed to create continuation message, stopping stream');
                break;
            }

            // Switch to new editor and update state with remaining content
            chatContext.editor = newEditor;
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
            await chatContext.editor.edit(displayText, { parseMode: 'MarkdownV2' });
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
    const { ctx, chatId, userMessageId, editor, typing, retryMenu } = chatContext;
    const { messageId } = editor.getIds();

    typing.stop();

    let finalMessage = formatResponse(response.text, response.thinkingText)

    // Append grounding metadata if present
    if (response.groundingData?.length) {
        finalMessage = appendGroundingToMessage(finalMessage, response.groundingData);
        console.log('[response-handler] Grounding metadata:', JSON.stringify(response.groundingData));
    }

    // Check if final message (with grounding) exceeds limit
    if (needsSplit(finalMessage)) {
        console.log('[response-handler] Final message with grounding exceeds limit, splitting...');

        const { currentPart, remaining } = smartSplit(finalMessage);

        // Send current part first
        await editor.edit(currentPart, { parseMode: 'MarkdownV2' });
        await saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botUserName,
            message: response.text || response.thinkingText || '寄了',
            replyToId: userMessageId,
            modelParts: response.modelParts,
        });

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
                await saveMessage({
                    chatId,
                    messageId: contMsg.message_id,
                    userId: botUserId,
                    date: new Date(),
                    userName: botUserName,
                    message: '[Continued]',
                    replyToId: userMessageId,
                    modelParts: response.modelParts,
                });
            }
        }

        typing.stop();
        return;
    }

    const hasText = Boolean(finalMessage);
    const hasImages = response.images.length > 0;

    console.log('[response-handler] Final response:', {
        hasText,
        hasImages,
        imageCount: response.images.length,
        textLength: response.text.length,
        thinkingLength: response.thinkingText.length,
        messageCount: chatContext.messageHistory.length,
    });

    if (hasImages) {
        // Send image
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
                // Save image message to database
                await saveMessage({
                    chatId,
                    messageId: sentMsg.message_id,
                    userId: botUserId,
                    date: new Date(),
                    userName: botUserName,
                    message: response.text || '[IMAGE]',
                    replyToId: userMessageId,
                    fileBuffer: photoBuffer,
                    modelParts: response.modelParts,
                });
            }
        }

        // Update or delete processing message
        if (hasText) {
            await editor.edit(finalMessage, { parseMode: 'MarkdownV2' });

            // Save current message to database
            await saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: new Date(),
                userName: botUserName,
                message: response.text || response.thinkingText,
                replyToId: userMessageId,
            });
        } else {
            await editor.delete();
        }
    } else if (hasText) {
        // Text only response
        await editor.edit(finalMessage, { parseMode: 'MarkdownV2' });

        // Save current message to database
        await saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botUserName,
            message: response.text || (response.thinkingText ? '[Thinking]' : '寄了'),
            replyToId: userMessageId,
            modelParts: response.modelParts,
        });
    } else {
        // No content - show error
        const fallbackMessage = '寄了';
        await editor.edit(fallbackMessage, { replyMarkup: retryMenu });
        await saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botUserName,
            message: fallbackMessage,
            replyToId: userMessageId,
        });
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
    const { chatId, userMessageId, editor, typing, retryMenu } = chatContext;
    const { messageId } = editor.getIds();

    typing.stop();

    // Save partial content if any
    if (partialText) {
        await saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botUserName,
            message: partialText,
            replyToId: userMessageId,
        });
    }

    // Format and display error
    const errorMessage = formatErrorForUser(error, partialText ? undefined : '错误');
    const displayMessage = partialText
        ? `${partialText}\n\n${errorMessage}`
        : errorMessage;

    const truncatedMessage = truncateForTelegram(displayMessage);

    const editResult = await to(
        editor.edit(truncatedMessage, { replyMarkup: retryMenu })
    );

    if (isErr(editResult)) {
        console.error('[response-handler] Failed to edit error message:', editResult[0]);
        // Retry after delay
        setTimeout(async () => {
            await editor.edit(truncatedMessage, { replyMarkup: retryMenu });
        }, 15000);
    }
};
