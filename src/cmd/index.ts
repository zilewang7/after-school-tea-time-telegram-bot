import { Bot } from "grammy";
import { matchFirstEmoji, removeSpecificText } from "../util";
import { generateImageByPrompt } from "../openai/image-generate";

export const cmdLoad = (bot: Bot) => {
    bot.command('start', (ctx) => ctx.reply('Welcome'));

    bot.command('help', (ctx) => ctx.reply('Send me a sticker'));

    bot.command('react', (ctx) => {
        const firstEmoji = matchFirstEmoji(ctx.message?.text);
        const replyId = ctx.message?.reply_to_message?.message_id
        const chatId = ctx.message?.chat.id

        if (!firstEmoji) {
            ctx.reply('No emoji found')
            return;
        }

        if (!replyId || !chatId) {
            ctx.reply('No reply found')
            return;
        }

        ctx.api.setMessageReaction(
            replyId,
            chatId,
            [{
                type: 'emoji',
                emoji: firstEmoji
            }]
        )
    })

    bot.command(['pic', 'pic1', 'pic2'], async (ctx) => {
        if (!ctx.message?.text) {
            return
        }

        const command = ctx.message?.text.split(' ')[0];

        if (!command?.startsWith('/pic')) {
            return
        }

        const msg = removeSpecificText(ctx.message.text, command);
        await generateImageByPrompt(ctx, command, msg);
    });
}