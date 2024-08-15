import { Bot, Context } from "grammy";
import { changeModel, matchFirstEmoji, removeSpecificText, sendModelMsg } from "../util";
import { generateImageByPrompt } from "../openai/image-generate";
import { Menus } from "./menu";

export const cmdLoad = async (bot: Bot, menus: Menus) => {
    bot.api.setMyCommands([
        { command: "start", description: "开始" },
        { command: "help", description: "没有帮助" },
        { command: "react", description: "给消息添加表情" },
        { command: "pic", description: "使用英文提示词生成图片-快速" },
        { command: "pic1", description: "使用英文提示词生成图片-均衡" },
        { command: "pic2", description: "使用英文提示词生成图片-粗糙" },
        { command: "model", description: "查看/切换大语言模型" },
    ]);


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

        const model = {
            'pic': '0',
            'pic1': '1',
            'pic2': '2',
        }[command] || '1';

        const msg = removeSpecificText(ctx.message.text, command);
        await generateImageByPrompt(ctx, model, msg);
    });

    bot.command('model', async (ctx) => {
        const match = ctx.match;

        if (match) {
            await changeModel(ctx, match, menus.checkModelMenu);
        } else {
            await sendModelMsg(ctx, menus.checkModelMenu);
        }
    });
}