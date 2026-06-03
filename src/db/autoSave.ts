import { Bot } from "grammy";
import { match } from "ts-pattern";
import { saveMessage, getMessage, findBotResponseByMessageId, BotResponse, MediaCache, ButtonState } from "./index.js";
import { Message } from "./messageDTO.js";
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
} from '../state.js';
import { buildResponseButtons } from '../cmd/menus/index.js';
import { getCachedMedia, putCachedMedia } from '../services/media-cache-service.js';
import { convertTgsToWebm } from '../services/tgs-client.js';
import { to } from 'await-to-js';
import type { Message as TgMessage } from 'grammy/types';

// Telegram's getFile download limit is 20MB; larger files cannot be downloaded
// by the bot at all, so we skip the download and keep only a text hint.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

type MediaKind =
    | 'photo' | 'sticker' | 'video_sticker' | 'animated_sticker'
    | 'voice' | 'audio' | 'video' | 'video_note' | 'document';

interface CapturedMedia {
    /** Telegram file_id to download */
    fileId: string;
    /** Stable cache key across re-sends */
    fileUniqueId: string;
    /** Final MIME to persist (animated stickers become video/webm after conversion) */
    mime: string;
    kind: MediaKind;
    /** File size in bytes if Telegram reported it (used for the size cap) */
    sizeBytes?: number;
    /** Human-readable hint appended to message text for non-multimodal models */
    hint: string;
    /** Animated sticker (.tgs) needs rendering to webm via the converter service */
    needsTgsConversion: boolean;
}

/**
 * Resolve a capturable media file from a Telegram message.
 * Returns undefined when the message carries no supported media.
 */
const resolveCapturedMedia = (msg: TgMessage | undefined): CapturedMedia | undefined => {
    if (!msg) return undefined;

    const photo = msg.photo?.at(-1);
    if (photo) {
        const isGroup = Boolean(msg.media_group_id);
        return {
            fileId: photo.file_id,
            fileUniqueId: photo.file_unique_id,
            mime: 'image/jpeg',
            kind: 'photo',
            sizeBytes: photo.file_size,
            hint: isGroup ? 'some pictures' : 'a picture',
            needsTgsConversion: false,
        };
    }

    const sticker = msg.sticker;
    if (sticker) {
        // Video sticker (.webm, VP9): download the real animation, Gemini can read it
        if (sticker.is_video) {
            return {
                fileId: sticker.file_id,
                fileUniqueId: sticker.file_unique_id,
                mime: 'video/webm',
                kind: 'video_sticker',
                sizeBytes: sticker.file_size,
                // The full animated clip is attached; tell the model it can watch the whole thing
                hint: 'an animated sticker (the full short video clip is attached, you can watch the entire animation, not just one frame)',
                needsTgsConversion: false,
            };
        }
        // Animated sticker (.tgs, Lottie vector): render to webm via converter service
        if (sticker.is_animated) {
            return {
                fileId: sticker.file_id,
                fileUniqueId: sticker.file_unique_id,
                mime: 'video/webm', // after conversion
                kind: 'animated_sticker',
                sizeBytes: sticker.file_size,
                hint: 'an animated sticker (the full short video clip is attached, you can watch the entire animation, not just one frame)',
                needsTgsConversion: true,
            };
        }
        return {
            fileId: sticker.file_id,
            fileUniqueId: sticker.file_unique_id,
            mime: 'image/webp',
            kind: 'sticker',
            sizeBytes: sticker.file_size,
            hint: 'a sticker image',
            needsTgsConversion: false,
        };
    }

    const voice = msg.voice;
    if (voice) {
        return {
            fileId: voice.file_id,
            fileUniqueId: voice.file_unique_id,
            mime: voice.mime_type ?? 'audio/ogg',
            kind: 'voice',
            sizeBytes: voice.file_size,
            hint: `a voice message${voice.duration ? `, ${voice.duration}s` : ''}`,
            needsTgsConversion: false,
        };
    }

    const audio = msg.audio;
    if (audio) {
        return {
            fileId: audio.file_id,
            fileUniqueId: audio.file_unique_id,
            mime: audio.mime_type ?? 'audio/mpeg',
            kind: 'audio',
            sizeBytes: audio.file_size,
            hint: `an audio file${audio.file_name ? `: ${audio.file_name}` : ''}`,
            needsTgsConversion: false,
        };
    }

    const video = msg.video;
    if (video) {
        return {
            fileId: video.file_id,
            fileUniqueId: video.file_unique_id,
            mime: video.mime_type ?? 'video/mp4',
            kind: 'video',
            sizeBytes: video.file_size,
            hint: 'a video',
            needsTgsConversion: false,
        };
    }

    const videoNote = msg.video_note;
    if (videoNote) {
        return {
            fileId: videoNote.file_id,
            fileUniqueId: videoNote.file_unique_id,
            mime: 'video/mp4',
            kind: 'video_note',
            sizeBytes: videoNote.file_size,
            hint: 'a video note',
            needsTgsConversion: false,
        };
    }

    const document = msg.document;
    if (document) {
        const mime = document.mime_type ?? 'application/octet-stream';
        return {
            fileId: document.file_id,
            fileUniqueId: document.file_unique_id,
            mime,
            kind: 'document',
            sizeBytes: document.file_size,
            hint: mime.startsWith('image/')
                ? 'a picture'
                : `a file: ${document.file_name ?? 'unknown'}, ${mime}`,
            needsTgsConversion: false,
        };
    }

    return undefined;
};

/** Outcome of trying to acquire media bytes into the cache */
type AcquireResult =
    | { status: 'cached'; fileUniqueId: string; mime: string }
    | { status: 'too_large' }
    | { status: 'download_failed' }
    | { status: 'convert_failed' };

/**
 * Ensure a media file's bytes are available in MediaCache, downloading and
 * (for animated stickers) converting as needed. Never throws — returns a
 * status the caller uses to pick the right text hint.
 */
const acquireMediaBytes = async (
    bot: Bot,
    media: CapturedMedia
): Promise<AcquireResult> => {
    // Cache hit: nothing to download/convert
    const cached = await getCachedMedia(media.fileUniqueId);
    if (cached) {
        return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: cached.mime };
    }

    // Oversized: Telegram won't let us download it
    if (media.sizeBytes !== undefined && media.sizeBytes > MAX_MEDIA_BYTES) {
        return { status: 'too_large' };
    }

    // Download raw bytes via getFile (may fail with "file is too big" for unknown sizes)
    const [downloadErr, rawBytes] = await to(downloadTelegramFile(bot, media.fileId));
    if (downloadErr || !rawBytes) {
        console.error(`[autoSave] download failed for ${media.kind}:`, downloadErr?.message || 'no bytes');
        return { status: 'download_failed' };
    }

    // Animated stickers (.tgs) must be rendered to webm before models can read them
    if (media.needsTgsConversion) {
        const converted = await convertTgsToWebm(rawBytes);
        if (!converted) {
            return { status: 'convert_failed' };
        }
        await putCachedMedia(media.fileUniqueId, converted.data, converted.mime, media.kind);
        return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: converted.mime };
    }

    await putCachedMedia(media.fileUniqueId, rawBytes, media.mime, media.kind);
    return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: media.mime };
};

const DOWNLOAD_TIMEOUT_MS = 30000;

/**
 * Download a Telegram file by file_id and return its bytes.
 * Bounded by a timeout so a network stall can't hang the async save flow.
 */
const downloadTelegramFile = async (bot: Bot, fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`file download HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
};

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

                const media = resolveCapturedMedia(ctx.update.message);

                // Build the base text + an optimistic media hint. This is saved
                // immediately so the message always lands in context, even if the
                // media download/conversion later fails (fixes the big-file bug).
                const baseText = isSubImage ? `sub image of [${replyToId}]` :
                    (
                        (/^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/.test(ctx.message?.text || '')
                            ? (ctx.message?.text?.match(/^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/)?.[4] || ' ')
                            : ''
                        )
                        || ctx.message?.text || ctx.message?.caption || ctx.update.message?.sticker?.emoji || ''
                    );

                const chatId = ctx.chat.id;
                const messageId = ctx.message.message_id;
                const userId = ctx.from.id;
                const date = new Date(ctx.message?.date * 1000);
                const userName = ctx.from.first_name;
                const quoteText = ctx.message?.quote?.text;

                // Mark the async file save BEFORE any await, so a rapid follow-up
                // reply that triggers waitForFileSave() will block until this
                // message's media is cached (fixes a context race).
                if (media) {
                    addAsyncFileSaveMsgId(messageId);
                }

                // Save text first (no media bytes yet)
                await saveMessage({
                    chatId,
                    messageId,
                    userId,
                    date,
                    userName,
                    message: baseText + (media ? ` (I send ${media.hint})` : '') + '<<EOF\n',
                    quoteText,
                    replyToId,
                });

                // Acquire media bytes asynchronously (download + optional .tgs->webm),
                // then update the saved message with the cache key or a corrected hint.
                if (media) {
                    // Hard backstop: never let the async-save flag stick (waitForFileSave
                    // would otherwise loop forever). Idempotent with the removal below.
                    const backstop = setTimeout(() => removeAsyncFileSaveMsgId(messageId), 70000);
                    void (async () => {
                        const [acquireErr, result] = await to(acquireMediaBytes(bot, media));
                        const outcome: AcquireResult = acquireErr || !result
                            ? { status: 'download_failed' }
                            : result;

                        const finalHint = match(outcome)
                            .with({ status: 'cached' }, () => media.hint)
                            .with({ status: 'too_large' }, () => `${media.hint}, [system] too large to process`)
                            .with({ status: 'download_failed' }, () => `${media.hint}, [system] failed to download`)
                            .with({ status: 'convert_failed' }, () => `${media.hint}, [system] failed to render, can not view`)
                            .exhaustive();

                        const [saveErr] = await to(saveMessage({
                            chatId,
                            messageId,
                            userId,
                            date,
                            userName,
                            message: baseText + ` (I send ${finalHint})` + '<<EOF\n',
                            quoteText,
                            fileMime: outcome.status === 'cached' ? outcome.mime : undefined,
                            fileUniqueId: outcome.status === 'cached' ? outcome.fileUniqueId : undefined,
                            replyToId,
                        }));
                        if (saveErr) {
                            console.error('[autoSave] Failed to update message with media:', saveErr);
                        }
                        clearTimeout(backstop);
                        removeAsyncFileSaveMsgId(messageId);
                    })();
                }
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
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

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

            // 媒体字节超过 1 天即清空，保留文字上下文（回复树仍按 id 引用旧消息）
            const [mediaClearedCount] = await Message.update(
                { file: null, fileMime: null },
                {
                    where: {
                        date: { [Op.lt]: oneDayAgo.toISOString() },
                        file: { [Op.ne]: null },
                    },
                }
            );

            // 共享媒体缓存按 LRU 清理：超 7 天未被命中续期的删除
            const mediaCacheResult = await MediaCache.destroy({
                where: {
                    lastUsedAt: { [Op.lt]: oneWeekAgo },
                },
            });

            console.log(`Cleared ${messageResult} messages, ${botResponseResult} bot responses before ${oneWeekAgo.toISOString()}; cleared media bytes of ${mediaClearedCount} messages before ${oneDayAgo.toISOString()}; evicted ${mediaCacheResult} media cache entries`);
        } catch (error) {
            console.error('Error during message cleanup:', error);
        }
    }, 1000 * 60 * 60); // 每小时运行一次
}