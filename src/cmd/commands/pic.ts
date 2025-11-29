import { Bot, Context, InputFile } from "grammy";
import { removeSpecificText } from "../../util";
import { grokAgent } from "../../openai";
import { saveMessage } from "../../db";

const botUserId = Number(process.env.BOT_USER_ID);
const botUserName = process.env.BOT_NAME;
const PICZIT_ENDPOINT = process.env.PICZIT_ENDPOINT;

// Handle /piczit command
async function handlePiczitCommand(ctx: Context, prompt: string, spoiler = true) {
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
        console.log('[piczit] generating image', {
            promptLength: prompt.length,
        });

        // Call the ComfyUI API
        const response = await fetch(`${PICZIT_ENDPOINT}/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prompt }),
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
            await ctx.api.deleteMessage(chatId, processingReply.message_id);
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
        console.error('Error in handlePiczitCommand:', error);

        // Check if it's a connection error
        const isConnectionError = error instanceof Error && (
            error.message.includes('fetch failed') ||
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('ETIMEDOUT')
        );

        const errorMsg = isConnectionError
            ? '生图服务未启动'
            : '生成图片失败：' + (error instanceof Error ? error.message : String(error));

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
