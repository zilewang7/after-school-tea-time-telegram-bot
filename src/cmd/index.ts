import { Bot, Context } from "grammy";
import { changeModel, matchFirstEmoji, removeSpecificText, sendModelMsg } from "../util";
import { generateImageByPrompt } from "../openai/image-generate";
import { Menus } from "./menu";
import { getRepliesHistory } from "../reply/helper";

export const cmdLoad = async (bot: Bot, menus: Menus) => {
    bot.api.setMyCommands([
        { command: "start", description: "开始" },
        { command: "help", description: "没有帮助" },
        { command: "react", description: "给消息添加表情" },
        { command: "pic", description: "使用英文提示词生成图片-快速" },
        { command: "pic1", description: "使用英文提示词生成图片-均衡" },
        { command: "pic2", description: "使用英文提示词生成图片-粗糙" },
        { command: "pic3", description: "使用英文提示词生成图片-推荐" },
        { command: "model", description: "查看/切换大语言模型" },
        { command: "chat", description: "为消息添加上下文关联再进行对话，回复消息时输入 /chat [数量] [筛选条件]" },
        { command: "context", description: "查看当前上下文结构" },
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
            chatId,
            replyId,
            [{
                type: 'emoji',
                emoji: firstEmoji
            }]
        )
    })

    bot.command(['pic', 'pic1', 'pic2', 'pic3'], async (ctx) => {
        if (!ctx.message?.text) {
            return
        }

        const command = ctx.message?.text.split(' ')[0];

        if (!command?.startsWith('/pic')) {
            return
        }

        const model = command.replace('/pic', '') || '1';

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

    bot.command('context', async (ctx) => {
        try {
            if (!ctx.message || !ctx.chat) { return; }

            if (!ctx.message.reply_to_message) {
                ctx.reply('请回复要查看的消息');
                return;
            }

            const originalMessages = await getRepliesHistory(ctx.chat.id, ctx.message.reply_to_message.message_id, { excludeSelf: false });


            if (originalMessages[0]) {
                const isSupergroup = ctx.chat.type === "supergroup";
                const firstMsg = originalMessages[0];

                let replyText = "*当前会话上下文:*"
                    + (isSupergroup ? ` [初始消息](https://t.me/c/${String(firstMsg.chatId).slice(4)}/${firstMsg.messageId})` : "")
                    + "\n\n**";

                originalMessages.forEach((msg, index) => {
                    const shortMsg = (msg.text || '').length > 12 ? ((msg.text || '').slice(0, 10) + '...') : (msg.text || '');

                    const chatId = isSupergroup ? String(msg.chatId).slice(4) : msg.chatId;

                    replyText += ">" + `\\>\`${msg.userName}:${(shortMsg)}\`` + (isSupergroup ? `[前往](https://t.me/c/${chatId}/${msg.messageId})` : "");

                    if (index < originalMessages.length - 1) {
                        replyText += '\n';
                    }
                })


                replyText += "||"

                await ctx.reply(replyText, {
                    parse_mode: 'MarkdownV2',
                });
            } else {
                ctx.reply('没有找到上下文');
            }
        } catch (error) {
            console.error(error);
            ctx.reply(error instanceof Error ? error.message : 'Unknown error');
        }
    })
}