/**
 * Retry handler for bot responses
 * Handles retry logic when user clicks retry button
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
import type { Context } from 'grammy';
import { getMessage, getBotResponse } from '../db';
import { getFileContentsOfMessage } from '../db/queries/context-queries';
import { startRetry } from '../services';
import { sendMessage, getSystemPrompt, getModelCapabilities } from '../ai';
import { buildContext, buildContextFromParts } from './context-builder';
import { getCurrentModel } from '../state';
import { to } from '../shared/result';
import {
    createChatContextForRetry,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './response-handler';
import type { UnifiedContentPart } from '../ai/types';

/**
 * Handle retry for a bot response
 */
export const handleRetryRequest = async (
    ctx: Context,
    firstMessageId: number
): Promise<void> => {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;

    console.log('[retry-handler] Starting retry for message:', firstMessageId);

    // Get bot response record
    const botResponse = await getBotResponse(chatId, firstMessageId);
    if (!botResponse) {
        console.error('[retry-handler] BotResponse not found');
        return;
    }

    // Check command type for routing
    const metadata = botResponse.getMetadata();
    const commandType = metadata.commandType || 'chat';

    if (commandType === 'picbanana') {
        return handlePicbananaRetry(ctx, botResponse);
    }

    // Default: handle as chat retry
    return handleChatRetry(ctx, botResponse);
};

/**
 * Handle retry for picbanana command
 */
const handlePicbananaRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session
    const session = await startRetry(ctx, botResponse.messageId);
    if (!session) {
        console.error('[retry-handler] Failed to create retry session for picbanana');
        return;
    }

    // Create chat context for retry
    const chatContext = createChatContextForRetry(ctx, session);

    // Get original user message to extract prompt and images
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Extract prompt from original message (strip /picbanana command prefix, EOF suffix, and "(I send ...)" suffix)
    const originalText = userMessage.text
        ?.replace(/<<EOF\s*$/, '')
        ?.replace(/\s*\(I send [^)]+\)\s*$/, '')
        || '';
    const commandMatch = originalText.match(/^\/picbanana(@\S+)?\s*([\s\S]*)?$/);
    const prompt = commandMatch?.[2]?.trim() || originalText;

    // Collect reference images (same logic as picbanana-handler)
    const referenceImages = new Set<string>();

    const appendImagesFromMessage = async (targetMessageId: number): Promise<void> => {
        const images = await getFileContentsOfMessage(chatId, targetMessageId);
        images.forEach((part) => {
            if (part.type === 'image' && part.imageData) {
                referenceImages.add(part.imageData);
            }
        });
    };

    // Check reply message for reference images
    if (userMessage.replyToId) {
        await appendImagesFromMessage(userMessage.replyToId);
    }

    // Check current message for images
    await appendImagesFromMessage(botResponse.userMessageId);

    // Build content parts
    const contentParts: UnifiedContentPart[] = [
        { type: 'text', text: prompt },
    ];

    referenceImages.forEach((imageData) => {
        contentParts.push({ type: 'image', imageData });
    });

    // Build context from parts
    const messages = buildContextFromParts(contentParts);

    // Send to Gemini image model
    const [streamErr, stream] = await to(
        sendMessage(messages, {
            model: 'gemini-3-pro-image-preview',
            signal: session.streamController.signal,
        })
    );
    if (streamErr) {
        console.error('[retry-handler] Failed to send picbanana message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    // Process stream (same as normal flow)
    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[retry-handler] Failed to process picbanana stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    // Send final response (same as normal flow)
    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[retry-handler] Failed to send picbanana final response:', sendErr);
    }
};

/**
 * Handle retry for normal chat
 */
const handleChatRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session
    const session = await startRetry(ctx, botResponse.messageId);
    if (!session) {
        console.error('[retry-handler] Failed to create retry session');
        return;
    }

    // Create chat context for retry (reuses same flow as normal messages)
    const chatContext = createChatContextForRetry(ctx, session);

    // Get original user message
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Build AI context (exclude current bot response since we're retrying it)
    const model = getCurrentModel();
    const capabilities = getModelCapabilities(model);
    const [ctxErr, chatContents] = await to(buildContext(userMessage, {
        capabilities,
        excludeMessageIds: [botResponse.messageId], // Exclude the bot response we're retrying
    }));
    if (ctxErr) {
        console.error('[retry-handler] Failed to build context:', ctxErr);
        await handleResponseError(chatContext, ctxErr);
        return;
    }

    // Send to AI
    const [streamErr, stream] = await to(
        sendMessage(chatContents, {
            model,
            systemPrompt: getSystemPrompt(),
            signal: session.streamController.signal,
        })
    );
    if (streamErr) {
        console.error('[retry-handler] Failed to send message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    // Process stream (same as normal flow)
    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[retry-handler] Failed to process stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    // Send final response (same as normal flow)
    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[retry-handler] Failed to send final response:', sendErr);
    }
};
