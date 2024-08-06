import { Bot } from "grammy";
import { saveMessage } from ".";
import { Message } from "./messageDTO";
import { Op } from "@sequelize/core";

// 自动保存消息到数据库
export const autoSave = (bot: Bot) => {
    // 使用中间件
    bot.use(async (ctx, next) => {
        if (ctx.chat?.id && ctx.message?.message_id && ctx.from?.id) {
            let fileLink;
            let isVideo = false;
            let replyToId = ctx.message.reply_to_message?.message_id;

            if (ctx.update.message?.media_group_id) {
                if (global.mediaGroupIdTemp.chatId === ctx.chat.id && global.mediaGroupIdTemp.mediaGroupId === ctx.message.media_group_id) {
                    replyToId = global.mediaGroupIdTemp.messageId;
                } else {
                    global.mediaGroupIdTemp = {
                        chatId: ctx.chat.id,
                        messageId: ctx.message.message_id,
                        mediaGroupId: ctx.update.message.media_group_id
                    }
                }
            }

            const photoFile = ctx.update.message?.photo?.at(-1);
            const stickerFile = ctx.update.message?.sticker;
            const fileId = photoFile?.file_id || stickerFile?.file_id;


            if (fileId) {
                if (ctx.update.message?.sticker?.is_video || ctx.update.message?.sticker?.is_animated) {
                    isVideo = true;
                } else {
                    fileLink = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.api.getFile(fileId)).file_path}`;
                    global.asynchronousFileSaveMsgIdList.push(ctx.message.message_id);
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
                        message:  ctx.message?.text || ctx.message?.caption || (isVideo ? `${stickerFile?.emoji} ([syetem] can not get video sticker)` : stickerFile?.emoji),
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