import { Telegraf } from "telegraf";
import { saveMessage } from ".";
import { Message } from "./messageDTO";
import { Op } from "@sequelize/core";

// 自动保存消息到数据库
export const autoSave = (bot: Telegraf) => {
    // 使用中间件
    bot.use(async (ctx, next) => {
        if (ctx?.chat?.id && ctx.message?.message_id && ctx?.from?.id) {
            let fileLink;
            let isVideo = false;
            let replyToId = (ctx.message as any)?.reply_to_message?.message_id;

            if ((ctx.update as any)?.message?.media_group_id) {
                if (global.mediaGroupIdTemp.chatId === ctx.chat.id && global.mediaGroupIdTemp.mediaGroupId === (ctx.update as any).message.media_group_id) {
                    replyToId = global.mediaGroupIdTemp.messageId;
                } else {
                    global.mediaGroupIdTemp = {
                        chatId: ctx.chat.id,
                        messageId: ctx.message.message_id,
                        mediaGroupId: (ctx.update as any).message.media_group_id
                    }
                }
            }

            const tgFile = (ctx.update as any)?.message?.photo?.[(ctx.update as any)?.message?.photo?.length - 1] || (ctx.update as any)?.message?.sticker;
            if (tgFile) {
                if ((ctx.update as any)?.message?.sticker?.is_video || (ctx.update as any)?.message?.sticker?.is_animated) {
                    isVideo = true;
                } else {
                    fileLink = (await bot.telegram.getFileLink(tgFile)).toString();
                    global.asynchronousFileSaveMsgIdList.push(ctx.message.message_id)
                }
            }

            try {
                saveMessage(
                    {
                        chatId: ctx.chat.id,
                        messageId: ctx.message.message_id,
                        userId: ctx.from.id,
                        date: new Date(ctx.message?.date * 1000),
                        userName: ctx.from.first_name,
                        message: ctx?.text || (isVideo ? `${tgFile?.emoji} ([syetem] can not get video sticker)` : tgFile?.emoji),
                        fileLink,
                        replyToId,
                    }
                );
            } catch {
                global.asynchronousFileSaveMsgIdList = global.asynchronousFileSaveMsgIdList.filter(id => id !== ctx.message?.message_id);
            }
        }

        await next();
    });
}


// 自动清除一周前的消息
export const autoClear = () => {
    setInterval(() => {
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        Message.destroy({ where: { date: { [Op.lt]: oneWeekAgo } } });

        console.log('clear message before ' + oneWeekAgo);
    }, 1000 * 60 * 60);
}