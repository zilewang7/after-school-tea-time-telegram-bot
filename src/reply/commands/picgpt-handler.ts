/**
 * Picgpt command handler
 * Handles /picgpt image generation command using OpenAI gpt-image-2
 */
import type { Context } from 'grammy';
import { to, isErr } from '../../shared/result.js';
import { collectReferenceImages } from './reference-images.js';
import { sendMessage } from '../../ai/index.js';
import { buildContextFromParts } from './../context-builder.js';
import {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './../response-handler.js';
import type { UnifiedContentPart } from '../../ai/types.js';

/**
 * Picgpt command data
 */
export interface PicgptCommandData {
    prompt: string;
    referenceImages: string[];
}

/**
 * Check if message is a /picgpt command and extract data
 */
export const checkPicgptCommand = async (
    ctx: Context
): Promise<[mention?: boolean, PicgptCommandData?]> => {
    if (!ctx.message || !ctx.chat) return [undefined];

    // Get text from message or caption
    const text =
        ctx.message.text ||
        ('caption' in ctx.message ? ctx.message.caption : undefined);
    if (!text) return [undefined];

    // Check command pattern
    const commandRegex = /^\/picgpt(@\S+)?\s*([\s\S]*)?$/;
    const matchResult = text.match(commandRegex);
    if (!matchResult) return [undefined];

    const prompt = matchResult[2]?.trim() || '';

    if (!prompt) {
        await ctx.reply('请提供图片描述');
        return [false];
    }

    // Reference images: the replied-to message (bot-generated pictures included)
    // and the command message itself
    const referenceImages = await collectReferenceImages(ctx.chat.id, [
        ctx.message.reply_to_message?.message_id,
        ctx.message.message_id,
    ]);

    return [
        true,
        {
            prompt,
            referenceImages,
        }
    ];
};

/**
 * Handle /picgpt command
 */
export const handlePicgptCommand = async (
    ctx: Context,
    commandData: PicgptCommandData
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    console.log('[picgpt] Processing command:', {
        prompt: commandData.prompt,
        referenceImageCount: commandData.referenceImages.length,
    });

    // Create chat context with picgpt command type
    const chatContext = await createChatContext(ctx, { commandType: 'picgpt' });
    if (!chatContext) {
        console.error('[picgpt] Failed to create chat context');
        return;
    }

    // Build content parts
    const contentParts: UnifiedContentPart[] = [
        { type: 'text', text: commandData.prompt },
    ];

    commandData.referenceImages.forEach((imageData) => {
        contentParts.push({ type: 'image', imageData });
    });

    // Build context from parts
    const messages = buildContextFromParts(contentParts);

    // Send to OpenAI image model
    const streamResult = await to(
        sendMessage(messages, {
            model: 'gpt-image-2-dev',
            signal: chatContext.session.streamController.signal,
        })
    );

    if (isErr(streamResult)) {
        await handleResponseError(chatContext, streamResult[0]);
        return;
    }
    const stream = streamResult[1];

    // Process stream
    const processResult = await to(processStream(stream, chatContext));
    if (isErr(processResult)) {
        await handleResponseError(chatContext, processResult[0]);
        return;
    }
    const response = processResult[1];

    console.log('[picgpt] Response:', {
        hasText: Boolean(response.text),
        hasThinking: Boolean(response.thinkingText),
        imageCount: response.images.length,
        imageSizes: response.images.map((buf) => buf.length),
    });

    // Send final response
    const sendResult = await to(sendFinalResponse(chatContext, response));
    if (isErr(sendResult)) {
        console.error('[picgpt] Failed to send response:', sendResult[0]);
    }
};
