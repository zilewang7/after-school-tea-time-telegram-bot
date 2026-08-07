/**
 * `/picgrok` — image generation through xAI.
 *
 * The comfy-forward commands (`/pic`, `/picunsafe`) used to live here too; they
 * are routed through chat-handler now, because they need reference images and
 * therefore have to wait for in-flight media. See reply/commands/pic-command.ts.
 */
import type { Bot, Context } from 'grammy';
import OpenAI from 'openai';
import { to, isErr } from '../../shared/result.js';
import { removeSpecificText } from '../../util.js';

// Grok agent for image generation
const grokAgent = new OpenAI({
    baseURL: process.env.GROK_API_URL,
    apiKey: process.env.GROK_API_KEY,
});

/**
 * Handle /picgrok command
 */
const generatePicgrokImage = async (
    ctx: Context,
    processingReplyId: number,
    prompt: string
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    console.log('[picgrok] generating image', { prompt });

    // Generate image
    const genResult = await to(
        grokAgent.images.generate({
            model: 'grok-imagine-image-quality',
            prompt,
        })
    );

    if (isErr(genResult)) {
        console.error('[picgrok] Error:', genResult[0]);
        const errorMsg = '生成图片失败：' + genResult[0].message;

        const editResult = await to(
            ctx.api.editMessageText(chatId, processingReplyId, errorMsg)
        );

        if (isErr(editResult)) {
            await to(ctx.api.deleteMessage(chatId, processingReplyId));
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
        await ctx.api.editMessageText(chatId, processingReplyId, errorMsg);
        return;
    }

    console.log('[picgrok] image generated', {
        promptLength: prompt.length,
        imageUrl,
    });

    // Delete processing message and send image
    await to(ctx.api.deleteMessage(chatId, processingReplyId));
    await ctx.api.sendPhoto(chatId, imageUrl, {
        reply_parameters: { message_id: userMessageId },
    });
};

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

    generatePicgrokImage(ctx, processingReply.message_id, prompt).catch(async (error) => {
        console.error('[picgrok] Error:', error);
        const errorMsg = '生成图片失败：' + (error instanceof Error ? error.message : String(error));

        const editResult = await to(
            ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg)
        );

        if (isErr(editResult)) {
            await to(ctx.api.deleteMessage(chatId, processingReply.message_id));
            await ctx.reply(errorMsg, {
                reply_parameters: { message_id: userMessageId },
            });
        }
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
};
