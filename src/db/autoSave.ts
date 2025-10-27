import dotenv from 'dotenv'
import { Bot } from "grammy";
import { saveMessage } from ".";
import { Message } from "./messageDTO";
import { Op } from "@sequelize/core";

dotenv.config();

// 自动保存消息到数据库
export const autoSave = (bot: Bot) => {
    // 使用中间件
    bot.use(async (ctx, next) => {
        const excludeList = ['/context'];
        
        excludeList.forEach((item) => {
            excludeList.push(item + `@${process.env.BOT_USER_NAME}`);
        })

        if (ctx.chat?.id && ctx.message?.message_id && ctx.from?.id && !excludeList.includes(ctx.message.text || '')) {
            let fileLink;
            let isVideo = false;
            let replyToId = ctx.message.reply_to_message?.message_id;
            let isSubImage = false;

            try {
                if (ctx.update.message?.media_group_id) {
                    if (global.mediaGroupIdTemp.chatId === ctx.chat.id && global.mediaGroupIdTemp.mediaGroupId === ctx.message.media_group_id) {
                        replyToId = global.mediaGroupIdTemp.messageId;
                        isSubImage = true;
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
                        const previewImageId = ctx.update.message.sticker.thumbnail?.file_id;
                        if (previewImageId) {
                            fileLink = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.api.getFile(previewImageId)).file_path}`;
                            global.asynchronousFileSaveMsgIdList.push(ctx.message.message_id);
                        }
                    } else {
                        fileLink = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.api.getFile(fileId)).file_path}`;
                        global.asynchronousFileSaveMsgIdList.push(ctx.message.message_id);
                    }

                    // 最多花费 10s 来保存文件
                    setTimeout(() => {
                        global.asynchronousFileSaveMsgIdList = global.asynchronousFileSaveMsgIdList.filter(id => id !== ctx.message?.message_id);
                    }, 10000);
                }

                const message = isSubImage ? `sub image of [${replyToId}]` :
                    (
                        (/^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/.test(ctx.message?.text || '')
                            ? (ctx.message?.text?.match(/^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/)?.[4] || ' ')
                            : ''
                        )
                        || ctx.message?.text || ctx.message?.caption || stickerFile?.emoji || ''
                    )
                    + (
                        fileId ?
                            (
                                ` (I send `
                                + (
                                    ctx.update.message?.photo?.length ?
                                        (ctx.update.message?.media_group_id ? 'some pictures' : 'a picture')
                                        : (isVideo ? 'a video sticker ([system] can not get video sticker, only thumbnail image)' : 'a sticker image')
                                )
                                + ')'
                            )
                            : ''
                    )
                    + "<<EOF\n"

                await saveMessage(
                    {
                        chatId: ctx.chat.id,
                        messageId: ctx.message.message_id,
                        userId: ctx.from.id,
                        date: new Date(ctx.message?.date * 1000),
                        userName: ctx.from.first_name,
                        message,
                        quoteText: ctx.message?.quote?.text,
                        fileLink,
                        replyToId,
                    }
                );
            } catch (error) {
                console.error("保存消息失败", error);
                global.asynchronousFileSaveMsgIdList = global.asynchronousFileSaveMsgIdList.filter(id => id !== ctx.message?.message_id);
            }
        }

        await next();
    });
}


// 自动清除一周前的消息
export const autoClear = () => {
    setInterval(async () => {
        try {
            const now = new Date();
            const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            
            // 使用 UTC 时间，确保一致性
            const result = await Message.destroy({ 
                where: { 
                    date: { 
                        [Op.lt]: oneWeekAgo.toISOString() 
                    } 
                } 
            });

            console.log(`Cleared ${result} messages before ${oneWeekAgo.toISOString()}`);
        } catch (error) {
            console.error('Error during message cleanup:', error);
        }
    }, 1000 * 60 * 60); // 每小时运行一次
}