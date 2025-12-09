/**
 * Picbanana command handler
 * Handles /picbanana image generation command
 */
import type { Context } from 'grammy';
import type { Menu } from '@grammyjs/menu';
import { to, isErr } from '../../shared/result';
import { getFileContentsOfMessage } from '../../db/queries/context-queries';
import { sendMessage } from '../../ai';
import { buildContextFromParts } from './../context-builder';
import {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './../response-handler';
import type { UnifiedContentPart } from '../../ai/types';

/**
 * Picbanana command data
 */
export interface PicbananaCommandData {
    prompt: string;
    referenceImages: string[];
}

/**
 * Check if message is a /picbanana command and extract data
 */
export const checkPicbananaCommand = async (
    ctx: Context
): Promise<[mention?: boolean, PicbananaCommandData?]> => {
    if (!ctx.message || !ctx.chat) return [undefined];

    // Get text from message or caption
    const text =
        ctx.message.text ||
        ('caption' in ctx.message ? ctx.message.caption : undefined);
    if (!text) return [undefined];

    // Check command pattern
    const commandRegex = /^\/picbanana(@\S+)?\s*([\s\S]*)?$/;
    const matchResult = text.match(commandRegex);
    if (!matchResult) return [undefined];

    const prompt = matchResult[2]?.trim() || '';

    if (!prompt) {
        await ctx.reply('请提供图片描述');
        return [false];
    }

    const chatId = ctx.chat.id;
    const currentMessageId = ctx.message.message_id;
    const referenceImages = new Set<string>();

    // Helper to append images from a message
    const appendImagesFromMessage = async (
        targetChatId: number,
        targetMessageId: number
    ): Promise<void> => {
        const images = await getFileContentsOfMessage(targetChatId, targetMessageId);
        images.forEach((part) => {
            if (part.type === 'image' && part.imageData) {
                referenceImages.add(part.imageData);
            }
        });
    };

    // Check reply message for reference images
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg) {
        await appendImagesFromMessage(chatId, replyMsg.message_id);
    }

    // Check current message for images
    await appendImagesFromMessage(chatId, currentMessageId);

    return [
        true,
        {
            prompt,
            referenceImages: Array.from(referenceImages),
        }
    ];
};

/**
 * Handle /picbanana command
 */
export const handlePicbananaCommand = async (
    ctx: Context,
    commandData: PicbananaCommandData,
    retryMenu: Menu<Context>
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    console.log('[picbanana] Processing command:', {
        promptLength: commandData.prompt.length,
        referenceImageCount: commandData.referenceImages.length,
    });

    // Create chat context
    const chatContext = await createChatContext(ctx, retryMenu);
    if (!chatContext) {
        console.error('[picbanana] Failed to create chat context');
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

    // Send to Gemini image model
    const streamResult = await to(
        sendMessage(messages, {
            model: 'gemini-3-pro-image-preview',
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

    console.log('[picbanana] Response:', {
        hasText: Boolean(response.text),
        hasThinking: Boolean(response.thinkingText),
        imageCount: response.images.length,
        imageSizes: response.images.map((buf) => buf.length),
    });

    // Send final response
    const sendResult = await to(sendFinalResponse(chatContext, response));
    if (isErr(sendResult)) {
        console.error('[picbanana] Failed to send response:', sendResult[0]);
    }
};
