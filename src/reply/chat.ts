import dotenv from 'dotenv'
import { Context, NarrowedContext, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Stream } from "openai/streaming.mjs";
import { checkIfMentioned, checkIfNeedRecentContext, getRepliesHistory, isPhotoContext, PhotoContext, StickerContext, TextContext, UnionContextType, isStickerContext, isTextContext } from "../util";
import { ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionContentPartText, ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { getMessage, saveMessage } from "../db";
import { sendMsgToOpenAI } from "../openai";
import { Update, Message } from "telegraf/types";

dotenv.config();

const botUserId = Number(process.env.BOT_USER_ID)
const botUserName = process.env.BOT_USER_NAME

const generalContext = async (ctx: UnionContextType): Promise<Array<ChatCompletionMessageParam>> => {
    const chatContents: Array<ChatCompletionMessageParam> = []

    const needRecentContext = checkIfNeedRecentContext(ctx.text ?? '');
    const historyReplies = await getRepliesHistory(ctx.chat.id, ctx.message.message_id, { needRecentContext });

    for (const repledMsg of historyReplies) {
        if (repledMsg?.userId === botUserId) {
            chatContents.push({
                role: 'assistant',
                content: repledMsg.text,
            })
        } else {
            const replyContent: Array<ChatCompletionContentPart> = [];

            const msgContent = {
                type: 'text' as const,
                text: `${repledMsg.userName}: `
                    + (repledMsg?.text || '')
            }

            replyContent.push(msgContent);

            if (repledMsg.file) {
                (replyContent[0] as ChatCompletionContentPartText).text += '(I send a picture/sticker)';
                replyContent.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:image/png;base64,${repledMsg.file.toString('base64')}`
                    }
                })
            }

            chatContents.push({
                role: 'user',
                content: replyContent
            })
        }
    }

    // 当前消息
    const msgContent: Array<ChatCompletionContentPart> = []

    msgContent.push({
        type: 'text' as const,
        text: `${ctx.message.from.first_name}`
            + `${ctx.message.reply_to_message ? `(repling to ${ctx.message.reply_to_message.from?.first_name || 'last message'})` : ''}: `
            + (ctx.text ||  (isStickerContext(ctx) && ctx.update.message.sticker?.emoji) || '')
    })

    const tgFile = (() => {
        if (isPhotoContext(ctx)) {
            return ctx.update?.message?.photo?.[ctx.update?.message?.photo.length - 1]
        } else if (isStickerContext(ctx)) {
            return ctx.update?.message?.sticker
        }
    })()

    if (tgFile) {
        if ((isStickerContext(ctx) && ctx.update?.message?.sticker?.is_video) || (isStickerContext(ctx) && ctx.update?.message?.sticker?.is_animated)) {
            (msgContent[0] as ChatCompletionContentPartText).text += ' ([syetem] can not get video sticker) (I send a sticker)';
        } else {
            const replyIsMediaGroup = !!(isPhotoContext(ctx) && ctx.update?.message?.media_group_id);

            (msgContent[0] as ChatCompletionContentPartText).text
                += ('(I send ' + (replyIsMediaGroup ? 'some ' : 'a ')
                    + (isStickerContext(ctx) ? 'sticker' : 'picture')
                    + (replyIsMediaGroup ? 's' : '') + ')')

            // 当 global.asynchronousFileSaveMsgIdList 有值时，表示正在保存文件，等待列表清空
            while (global.asynchronousFileSaveMsgIdList.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const firstMsg = await getMessage(ctx.chat.id, ctx.message.message_id);

            if (firstMsg?.file && replyIsMediaGroup) {
                const fileList = [firstMsg.file];

                for (const replyId of (JSON.parse(firstMsg.replies))) {
                    const msg = await getMessage(ctx.chat.id, replyId);
                    if (msg?.file) {
                        fileList.push(msg.file);
                    }
                }

                for (const file of fileList) {
                    msgContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:image/png;base64,${file.toString('base64')}`
                        }
                    })
                }
            }
        }
    }

    chatContents.push({
        role: 'user' as const,
        content: msgContent
    })

    return chatContents;
}

async function sendMsgToOpenAIWithRetry(chatContents: ChatCompletionMessageParam[]): Promise<Stream<ChatCompletionChunk>> {
    // log
    chatContents.map(chatContent => {
        const transContents = []
        if (chatContent.role === 'user' && chatContent.content instanceof Array) {
            const transContent: any[] = [];
            chatContent.content.forEach((content) => {
                if (content.type === 'image_url') {
                    transContent.push({
                        type: 'image_url',
                        urlLength: content.image_url.url.length
                    })
                } else {
                    transContent.push(content)
                }
            })
            transContents.push({
                role: 'user',
                content: transContent
            })
        } else {
            transContents.push(chatContent)
        }
        console.log(chatContent.role, ...transContents)
    })

    const timeout = 8000; // 8 seconds timeout

    async function attempt(): Promise<Stream<ChatCompletionChunk>> {
        return new Promise<Stream<ChatCompletionChunk>>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout'));
            }, timeout);

            sendMsgToOpenAI(chatContents)
                .then((stream) => {
                    clearTimeout(timeoutId);
                    resolve(stream);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    while (true) {
        try {
            const stream = await attempt();
            return stream; // If attempt is successful, return the stream
        } catch (error) {
            if (error instanceof Error && error.message === 'Timeout') {
                // Retry if there is a timeout
                console.log('Retrying due to timeout...');
            } else {
                throw error;
            }
        }
    }
}
export const replyChat = (bot: Telegraf) => {
    bot.on([message('text'), message('photo'), message('sticker')], async (ctx) => {

        // 如果没有被提及，不需要回复
        if (!checkIfMentioned(ctx)) { return; }
    
        // 如果是图片组，后面的图片不需要重复回复
        if (
            isPhotoContext(ctx) &&
            global.mediaGroupIdTemp.chatId === ctx.chat.id &&
            global.mediaGroupIdTemp.messageId !== ctx.message.message_id &&
            global.mediaGroupIdTemp.mediaGroupId === ctx.update?.message?.media_group_id
        ) {
            return;
        }
    
        ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
    
        const currentReply = await ctx.reply('Processing...', {
            reply_parameters: {
                message_id: ctx.message.message_id
            }
        });
        const messageId = currentReply.message_id;
        const chatId = currentReply.chat.id;
        const replyDate = new Date(currentReply.date);
        let currentMsg = currentReply.text;
    
        // 追加内容
        const addReply = async (content: string) => {
            const lastMsg = currentMsg.slice(0, -14);
            const msg = lastMsg + content + '\nProcessing...';
    
            await ctx.telegram.editMessageText(chatId, messageId, undefined, msg);
            currentMsg = msg;
        }
    
        const chatContents = await generalContext(ctx);
    
        try {
            const stream: Stream<ChatCompletionChunk> = await sendMsgToOpenAIWithRetry(chatContents);
    
            let buffer = '';
    
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    buffer += content;
    
                    // 每当缓冲区长度达到一定阈值时，批量追加回复
                    if (buffer.length >= 75) {
                        await addReply(buffer);
                        buffer = '';  // 清空缓冲区
                    }
                }
            }
    
            // 如果缓冲区中仍有内容，最后一次性追加
            if (buffer.length > 0) {
                await addReply(buffer);
            }
    
            const finalMsg = currentMsg === 'Processing...' ? '寄了' : currentMsg.slice(0, -14)
    
            ctx.telegram.editMessageText(chatId, messageId, undefined, finalMsg, {
                parse_mode: 'Markdown'
            });
            saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: finalMsg,
                replyToId: ctx.message.message_id,
            });
        } catch (error) {
            const errorMsg = currentMsg + '\n' + (error instanceof Error ? error.message : 'Unknown error');
            ctx.telegram.editMessageText(chatId, messageId, undefined, errorMsg)
            saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: errorMsg,
                replyToId: ctx.message.message_id,
            });
        }
    })
}