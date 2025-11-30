import { Bot, Context, InputFile } from "grammy";
import { removeSpecificText } from "../../util";
import { grokAgent } from "../../openai";
import { saveMessage } from "../../db";

const botUserId = Number(process.env.BOT_USER_ID);
const botUserName = process.env.BOT_NAME;
const PICZIT_ENDPOINT = process.env.PICZIT_ENDPOINT;

// Health check with 2s timeout
async function checkPiczitHealth(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`${PICZIT_ENDPOINT}/health`, {
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        console.log('[piczit] health check failed:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

// Async image generation (runs in background)
async function generatePiczitImage(ctx: Context, processingReplyId: number, prompt: string, spoiler: boolean) {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    try {
        // Parse negative prompt
        let mainPrompt = prompt;
        let negativePrompt: string | undefined;
        let negativePromptOverride = false;

        if (prompt.includes('-!:')) {
            const parts = prompt.split('-!:');
            mainPrompt = (parts[0] || '').trim();
            negativePrompt = parts.slice(1).join('-!:').trim();
            negativePromptOverride = true;
        } else if (prompt.includes('-:')) {
            const parts = prompt.split('-:');
            mainPrompt = (parts[0] || '').trim();
            negativePrompt = parts.slice(1).join('-:').trim();
        }

        console.log('[piczit] generating image', {
            promptLength: mainPrompt.length,
            hasNegativePrompt: !!negativePrompt,
            negativePromptOverride,
        });

        // Build request body
        const requestBody: {
            prompt: string;
            negative_prompt?: string;
            negative_prompt_override?: boolean;
        } = { prompt: mainPrompt };
        if (negativePrompt) {
            requestBody.negative_prompt = negativePrompt;
            if (negativePromptOverride) {
                requestBody.negative_prompt_override = true;
            }
        }

        // Call the ComfyUI API
        const response = await fetch(`${PICZIT_ENDPOINT}/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        // Get image buffer from response
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        console.log('[piczit] image generated', {
            promptLength: prompt.length,
            imageSize: buffer.length,
        });

        // Delete processing message
        try {
            await ctx.api.deleteMessage(chatId, processingReplyId);
        } catch (error) {
            console.error('Failed to delete processing message:', error);
        }

        // Send image as reply
        const sentMsg = await ctx.api.sendPhoto(chatId, new InputFile(buffer as any), {
            reply_parameters: { message_id: userMessageId },
            has_spoiler: spoiler,
        });

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
    } catch (error) {
        console.error('Error in generatePiczitImage:', error);

        const errorMsg = '生成图片失败：' + (error instanceof Error ? error.message : String(error));

        try {
            await ctx.api.editMessageText(chatId, processingReplyId, errorMsg);
        } catch (editError) {
            console.error('Failed to edit error message:', editError);
            // Fallback: delete processing message and send new error message
            try {
                await ctx.api.deleteMessage(chatId, processingReplyId);
            } catch (delError) {
                console.error('Failed to delete processing message:', delError);
            }
            await ctx.api.sendMessage(chatId, errorMsg, {
                reply_parameters: { message_id: userMessageId }
            });
        }
    }
}

// Handle /piczit command
async function handlePiczitCommand(ctx: Context, prompt: string, spoiler = true) {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Check health first
    const isHealthy = await checkPiczitHealth();

    if (!isHealthy) {
        await ctx.reply('生图服务未启动', {
            reply_parameters: { message_id: userMessageId }
        });
        return;
    }

    // Send "generating" message
    const processingReply = await ctx.reply('Processing...', {
        reply_parameters: { message_id: userMessageId }
    });

    // Start async generation
    generatePiczitImage(ctx, processingReply.message_id, prompt, spoiler).catch(error => {
        console.error('Unhandled error in generatePiczitImage:', error);
    });
}

// Handle /picgrok command
async function handlePicgrokCommand(ctx: Context, prompt: string) {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Send typing action
    await ctx.api.sendChatAction(chatId, 'typing');

    const processingReply = await ctx.reply('Processing...', {
        reply_parameters: {
            message_id: userMessageId
        }
    });

    try {
        console.log('[picgrok] generating image', {
            promptLength: prompt.length,
        });

        const response = await grokAgent.images.generate({
            model: "grok-2-image-1212",
            prompt: prompt,
        });

        if (!response.data?.[0]?.url) {
            throw new Error("No image URL found in response");
        }

        console.log('[picgrok] image generated', {
            promptLength: prompt.length,
            imageUrl: response.data[0].url,
        });

        // Delete processing message
        try {
            await ctx.api.deleteMessage(chatId, processingReply.message_id);
        } catch (error) {
            console.error('Failed to delete processing message:', error);
        }

        // Send image as reply
        await ctx.api.sendPhoto(chatId, response.data[0].url, {
            reply_parameters: { message_id: userMessageId },
        });

    } catch (error) {
        console.error('Error in handlePicgrokCommand:', error);
        const errorMsg = '生成图片失败：' + (error instanceof Error ? error.message : String(error));

        try {
            await ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg);
        } catch (editError) {
            console.error('Failed to edit error message:', editError);
            // Fallback: delete processing message and send new error message
            try {
                await ctx.api.deleteMessage(chatId, processingReply.message_id);
            } catch (delError) {
                console.error('Failed to delete processing message:', delError);
            }
            await ctx.reply(errorMsg, {
                reply_parameters: { message_id: userMessageId }
            });
        }
    }
}

export const registerPicCommands = (bot: Bot) => {
    bot.command("picgrok", async (ctx) => {
        if (!ctx.message?.text) {
            return;
        }

        const command = ctx.message?.text.split(" ")[0];
        const msg = removeSpecificText(ctx.message.text, command);

        if (!msg || !msg.trim()) {
            await ctx.reply("请输入图片描述");
            return;
        }

        await handlePicgrokCommand(ctx, msg);
    });

    bot.command("piczit", async (ctx) => {
        if (!ctx.message?.text) {
            return;
        }

        const command = ctx.message?.text.split(" ")[0];
        const msg = removeSpecificText(ctx.message.text, command);

        if (!msg || !msg.trim()) {
            await ctx.reply("请输入图片描述");
            return;
        }

        await handlePiczitCommand(ctx, msg);
    });

    bot.command("piczitunsafe", async (ctx) => {
        if (!ctx.message?.text) {
            return;
        }

        const command = ctx.message?.text.split(" ")[0];
        const msg = removeSpecificText(ctx.message.text, command);

        if (!msg || !msg.trim()) {
            await ctx.reply("请输入图片描述");
            return;
        }

        await handlePiczitCommand(ctx, msg, false);
    });
};
