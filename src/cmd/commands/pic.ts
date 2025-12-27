/**
 * Image generation commands
 */
import { match } from 'ts-pattern';
import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import OpenAI from 'openai';
import { to, isErr } from '../../shared/result';
import { removeSpecificText } from '../../util';
import { saveMessage } from '../../db';

const botUserId = Number(process.env.BOT_USER_ID);
const botUserName = process.env.BOT_NAME;
const PICZIT_ENDPOINT = process.env.PICZIT_ENDPOINT;

// Grok agent for image generation
const grokAgent = new OpenAI({
    baseURL: process.env.GROK_API_URL,
    apiKey: process.env.GROK_API_KEY,
});

/**
 * Parse prompt with negative prompt support
 */
interface ParsedPrompt {
    mainPrompt: string;
    negativePrompt?: string;
    negativePromptOverride: boolean;
}

const parsePromptWithNegative = (prompt: string): ParsedPrompt => {
    return match(prompt)
        .when(
            (p) => p.includes('-!:'),
            (p) => {
                const parts = p.split('-!:');
                return {
                    mainPrompt: (parts[0] || '').trim(),
                    negativePrompt: parts.slice(1).join('-!:').trim() || undefined,
                    negativePromptOverride: true,
                };
            }
        )
        .when(
            (p) => p.includes('-:'),
            (p) => {
                const parts = p.split('-:');
                return {
                    mainPrompt: (parts[0] || '').trim(),
                    negativePrompt: parts.slice(1).join('-:').trim() || undefined,
                    negativePromptOverride: false,
                };
            }
        )
        .otherwise((p) => ({
            mainPrompt: p,
            negativePrompt: undefined,
            negativePromptOverride: false,
        }));
};

/**
 * Check piczit service health
 */
const checkPiczitHealth = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const healthResult = await to(
        fetch(`${PICZIT_ENDPOINT}/health`, { signal: controller.signal })
    );

    clearTimeout(timeoutId);

    if (isErr(healthResult)) {
        console.log('[piczit] health check failed:', healthResult[0].message);
        return false;
    }

    return healthResult[1].ok;
};

/**
 * Generate image using piczit service
 */
const generatePiczitImage = async (
    ctx: Context,
    processingReplyId: number,
    prompt: string,
    spoiler: boolean
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Parse prompt
    const { mainPrompt, negativePrompt, negativePromptOverride } =
        parsePromptWithNegative(prompt);

    console.log('[piczit] generating image', {
        promptLength: mainPrompt.length,
        hasNegativePrompt: Boolean(negativePrompt),
        negativePromptOverride,
    });

    // Build request body
    const requestBody: Record<string, unknown> = { prompt: mainPrompt };
    if (negativePrompt) {
        requestBody.negative_prompt = negativePrompt;
        if (negativePromptOverride) {
            requestBody.negative_prompt_override = true;
        }
    }

    // Call API
    const fetchResult = await to(
        fetch(`${PICZIT_ENDPOINT}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        })
    );

    if (isErr(fetchResult)) {
        throw fetchResult[0];
    }

    const response = fetchResult[1];
    if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    // Get image buffer
    const bufferResult = await to(response.arrayBuffer());
    if (isErr(bufferResult)) {
        throw bufferResult[0];
    }

    const buffer = Buffer.from(bufferResult[1]);

    console.log('[piczit] image generated', {
        promptLength: prompt.length,
        imageSize: buffer.length,
    });

    // Delete processing message
    await to(ctx.api.deleteMessage(chatId, processingReplyId));

    // Send image
    const sendResult = await to(
        ctx.api.sendPhoto(chatId, new InputFile(buffer as any), {
            reply_parameters: { message_id: userMessageId },
            has_spoiler: spoiler,
        })
    );

    if (isErr(sendResult)) {
        throw sendResult[0];
    }

    const sentMsg = sendResult[1];

    // Save to database
    await saveMessage({
        chatId,
        messageId: sentMsg.message_id,
        userId: botUserId,
        date: new Date(),
        userName: botUserName,
        message: '[IMAGE]',
        replyToId: userMessageId,
        fileBuffer: buffer,
    });
};

/**
 * Handle /piczit command
 */
const handlePiczitCommand = async (
    ctx: Context,
    prompt: string,
    spoiler = true
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Health check
    const isHealthy = await checkPiczitHealth();
    if (!isHealthy) {
        await ctx.reply('生图服务未启动', {
            reply_parameters: { message_id: userMessageId },
        });
        return;
    }

    const replyResult = await to(
        ctx.reply('Processing...', {
            reply_parameters: { message_id: userMessageId },
        })
    );

    if (isErr(replyResult)) {
        console.error('[piczit] Failed to send processing message:', replyResult[0]);
        return;
    }

    const processingReply = replyResult[1];

    // Generate image (async)
    generatePiczitImage(ctx, processingReply.message_id, prompt, spoiler).catch(
        async (error) => {
            console.error('[piczit] Error:', error);
            const errorMsg = '生成图片失败：' + (error instanceof Error ? error.message : String(error));

            const editResult = await to(
                ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg)
            );

            if (isErr(editResult)) {
                await to(ctx.api.deleteMessage(chatId, processingReply.message_id));
                await ctx.api.sendMessage(chatId, errorMsg, {
                    reply_parameters: { message_id: userMessageId },
                });
            }
        }
    );
};

/**
 * Handle /picgrok command
 */
const handlePicgrokCommand = async (ctx: Context, prompt: string): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Send typing action
    await ctx.api.sendChatAction(chatId, 'typing');

    const replyResult = await to(
        ctx.reply('Processing...', {
            reply_parameters: { message_id: userMessageId },
        })
    );

    if (isErr(replyResult)) {
        console.error('[picgrok] Failed to send processing message:', replyResult[0]);
        return;
    }

    const processingReply = replyResult[1];

    console.log('[picgrok] generating image', { promptLength: prompt.length });

    // Generate image
    const genResult = await to(
        grokAgent.images.generate({
            model: 'grok-2-image-1212',
            prompt,
        })
    );

    if (isErr(genResult)) {
        console.error('[picgrok] Error:', genResult[0]);
        const errorMsg = '生成图片失败：' + genResult[0].message;

        const editResult = await to(
            ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg)
        );

        if (isErr(editResult)) {
            await to(ctx.api.deleteMessage(chatId, processingReply.message_id));
            await ctx.reply(errorMsg, {
                reply_parameters: { message_id: userMessageId },
            });
        }
        return;
    }

    const response = genResult[1];

    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) {
        const errorMsg = '生成图片失败：No image URL in response';
        await ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg);
        return;
    }

    console.log('[picgrok] image generated', {
        promptLength: prompt.length,
        imageUrl,
    });

    // Delete processing message and send image
    await to(ctx.api.deleteMessage(chatId, processingReply.message_id));
    await ctx.api.sendPhoto(chatId, imageUrl, {
        reply_parameters: { message_id: userMessageId },
    });
};

/**
 * Extract prompt from command message
 */
const extractPrompt = (ctx: Context): string | null => {
    if (!ctx.message?.text) return null;

    const command = ctx.message.text.split(' ')[0];
    const msg = removeSpecificText(ctx.message.text, command);

    return msg?.trim() || null;
};

/**
 * Register image commands on bot
 */
export const registerPicCommands = (bot: Bot): void => {
    bot.command('picgrok', async (ctx) => {
        const prompt = extractPrompt(ctx);
        if (!prompt) {
            await ctx.reply('请输入图片描述');
            return;
        }
        await handlePicgrokCommand(ctx, prompt);
    });

    bot.command('piczit', async (ctx) => {
        const prompt = extractPrompt(ctx);
        if (!prompt) {
            await ctx.reply('请输入图片描述');
            return;
        }
        await handlePiczitCommand(ctx, prompt);
    });

    bot.command('piczitunsafe', async (ctx) => {
        const prompt = extractPrompt(ctx);
        if (!prompt) {
            await ctx.reply('请输入图片描述');
            return;
        }
        await handlePiczitCommand(ctx, prompt, false);
    });
};
