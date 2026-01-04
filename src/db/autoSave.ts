import { Bot } from "grammy";
import { saveMessage, getMessage, findBotResponseByMessageId, BotResponse, ButtonState } from ".";
import { Message } from "./messageDTO";
import { Op } from "@sequelize/core";
import {
    getMediaGroupIdTemp,
    setMediaGroupIdTemp,
    addAsyncFileSaveMsgId,
    removeAsyncFileSaveMsgId,
    setEditMonitorBot,
    getEditMonitorBot,
    getEditMonitorEntry,
    removeEditMonitorEntry,
} from '../state';
import { buildResponseButtons } from '../cmd/menus';
import to from 'await-to-js';

// 监听编辑消息并更新数据库
export const autoUpdate = (bot: Bot) => {
    bot.on('edited_message', async (ctx) => {
        const editedMsg = ctx.editedMessage;
        if (!editedMsg || !ctx.chat?.id) return;

        const chatId = ctx.chat.id;
        const messageId = editedMsg.message_id;

        // 检查消息是否已存在于数据库
        const existingMessage = await getMessage(chatId, messageId);
        if (!existingMessage) {
            // 没有存过的消息不需要更新
            return;
        }

        try {
            // 获取新的文本内容
            const newText = editedMsg.text || editedMsg.caption || '';

            if (newText) {
                existingMessage.text = newText + "<<EOF\n";
                existingMessage.date = new Date(editedMsg.edit_date! * 1000);
                await existingMessage.save();

                console.log(`[autoUpdate] Updated message ${messageId} in chat ${chatId}`);

                // Check if this message is in the monitored list
                const entry = getEditMonitorEntry(chatId, messageId);
                const monitorBot = getEditMonitorBot();
                if (entry && monitorBot) {
                    await addEditDetectedButton(monitorBot, chatId, entry.firstMessageId);
                    removeEditMonitorEntry(chatId, messageId);
                }
            }
        } catch (error) {
            console.error("[autoUpdate] 更新消息失败", error);
        }
    });
};

/**
 * Initialize edit monitor with bot instance
 */
export const startEditMonitor = (bot: Bot) => {
    setEditMonitorBot(bot);
    console.log('[editMonitor] Initialized');
};

const addEditDetectedButton = async (bot: Bot, chatId: number, firstMessageId: number): Promise<void> => {
    const response = await BotResponse.findOne({
        where: { chatId, messageId: firstMessageId },
    });

    if (!response || response.buttonState !== ButtonState.NONE) return;

    const currentVersion = response.getCurrentVersion();
    if (!currentVersion) return;

    // Update button state
    response.buttonState = ButtonState.EDIT_DETECTED;
    await response.save();

    // Add retry button to the bot message
    const lastMessageId = currentVersion.messageIds.at(-1) || currentVersion.currentMessageId;
    const buttons = buildResponseButtons(ButtonState.EDIT_DETECTED);

    const [err] = await to(
        bot.api.editMessageReplyMarkup(chatId, lastMessageId, {
            reply_markup: buttons,
        })
    );

    if (err) {
        console.error(`[editMonitor] Failed to add retry button to message ${lastMessageId}:`, err);
    } else {
        console.log(`[editMonitor] Added edit-detected retry button to message ${lastMessageId}`);
    }
};

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

            // If replying to a bot message, resolve to firstMessageId
            // This ensures context building works correctly even after version switching
            if (replyToId) {
                const botResponse = await findBotResponseByMessageId(ctx.chat.id, replyToId);
                if (botResponse) {
                    replyToId = botResponse.messageId; // Use firstMessageId
                }
            }

            try {
                if (ctx.update.message?.media_group_id) {
                    const mediaGroupTemp = getMediaGroupIdTemp();
                    if (mediaGroupTemp.chatId === ctx.chat.id && mediaGroupTemp.mediaGroupId === ctx.message.media_group_id) {
                        replyToId = mediaGroupTemp.messageId;
                        isSubImage = true;
                    } else {
                        setMediaGroupIdTemp({
                            chatId: ctx.chat.id,
                            messageId: ctx.message.message_id,
                            mediaGroupId: ctx.update.message.media_group_id
                        });
                    }
                }

                const photoFile = ctx.update.message?.photo?.at(-1);
                const stickerFile = ctx.update.message?.sticker;
                const documentFile = ctx.update.message?.document?.mime_type?.startsWith('image/') ? ctx.update.message?.document : undefined;
                const fileId = photoFile?.file_id || stickerFile?.file_id || documentFile?.file_id;


                if (fileId) {
                    if (ctx.update.message?.sticker?.is_video || ctx.update.message?.sticker?.is_animated) {
                        isVideo = true;
                        const previewImageId = ctx.update.message.sticker.thumbnail?.file_id;
                        if (previewImageId) {
                            fileLink = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.api.getFile(previewImageId)).file_path}`;
                            addAsyncFileSaveMsgId(ctx.message.message_id);
                        }
                    } else {
                        fileLink = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.api.getFile(fileId)).file_path}`;
                        addAsyncFileSaveMsgId(ctx.message.message_id);
                    }

                    // max 10s for file saving
                    setTimeout(() => {
                        if (ctx.message?.message_id) {
                            removeAsyncFileSaveMsgId(ctx.message.message_id);
                        }
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
                                    !!(ctx.update.message?.photo?.length || documentFile?.file_id) ?
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
                if (ctx.message?.message_id) {
                    removeAsyncFileSaveMsgId(ctx.message.message_id);
                }
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
            const messageResult = await Message.destroy({
                where: {
                    date: {
                        [Op.lt]: oneWeekAgo.toISOString()
                    }
                }
            });

            // 清理 BotResponse 表
            const botResponseResult = await BotResponse.destroy({
                where: {
                    createdAt: {
                        [Op.lt]: oneWeekAgo
                    }
                }
            });

            console.log(`Cleared ${messageResult} messages, ${botResponseResult} bot responses before ${oneWeekAgo.toISOString()}`);
        } catch (error) {
            console.error('Error during message cleanup:', error);
        }
    }, 1000 * 60 * 60); // 每小时运行一次
}