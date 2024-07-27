import { Telegraf, Telegram } from "telegraf";
import { matchFirstEmoji, removeSpecificText } from "../util";
import { TelegramEmoji } from "telegraf/types";
import { generateImageByPrompt } from "../openai/image-generate";

export const cmdLoad = (bot: Telegraf) => {
    bot.start((ctx) => ctx.reply('Welcome'))
    bot.help((ctx) => ctx.reply('Send me a sticker'))

    bot.command('react', (ctx) => {
        const firstEmoji = matchFirstEmoji(ctx.message.text);
        const replyId = ctx.message.reply_to_message?.message_id
        const chatId = ctx.message.chat.id

        if (!firstEmoji) {
            ctx.reply('No emoji found')
            return;
        }

        if (!replyId) {
            ctx.reply('No reply found')
            return;
        }

        ctx.telegram.setMessageReaction(
            chatId,
            replyId,
            [{
                type: 'emoji',
                emoji: firstEmoji as TelegramEmoji
            }]
        )
    })
    
    bot.command('pic', async (ctx) => {
        const msg = removeSpecificText(ctx.message.text, '/pic');
        await generateImageByPrompt(ctx, '0', msg);
    });
    
    bot.command('pic1', async (ctx) => {
        const msg = removeSpecificText(ctx.message.text, '/pic1');
        await generateImageByPrompt(ctx, '1', msg);
    });
    
    bot.command('pic2', async (ctx) => {
        const msg = removeSpecificText(ctx.message.text, '/pic1');
        await generateImageByPrompt(ctx, '2', msg);
    });
}