import dotenv from 'dotenv'
import { Bot, Context } from "grammy";
import { Stream } from "openai/streaming.mjs";
import { checkIfMentioned, checkIfNeedRecentContext, getRepliesHistory } from "../util";
import { ChatCompletion, ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionContentPartText, ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { getMessage, saveMessage } from "../db";
import { sendMsgToOpenAI } from "../openai";
import { MessageContent } from '../openai/index';
import { GenerateContentStreamResult } from '@google/generative-ai';
import { Menus } from '../cmd/menu';
import { Menu } from '@grammyjs/menu';

dotenv.config();

const botUserId = Number(process.env.BOT_USER_ID)
const botUserName = process.env.BOT_NAME

const generalContext = async (ctx: Context): Promise<Array<MessageContent>> => {
    if (!ctx.message) { return []; }

    const chatContents: Array<MessageContent> = []

    const needRecentContext = checkIfNeedRecentContext(ctx.message.text ?? '');
    const historyReplies = await getRepliesHistory(ctx.message.chat.id, ctx.message.message_id, { needRecentContext });

    for (const repledMsg of historyReplies) {
        if (repledMsg?.fromBotSelf) {
            chatContents.push({
                role: 'assistant',
                content: repledMsg.text || '[system] message lost',
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

    const replyText = await (async () => {
        if (ctx.message?.reply_to_message) {
            let text = '([system]repling to ['
            const msgText = (await getMessage(ctx.message.chat.id, ctx.message.reply_to_message.message_id))?.text

            if (msgText) {
                text += `${msgText.length > 20 ? (msgText.slice(0, 20) + '...') : msgText}]`
            } else {
                text += 'last message]'
            }

            if (ctx.message?.quote?.text) {
                text += `[quote: ${ctx.message.quote.text}]`
            }

            text += '): '
            return text;
        } else {
            return ': '
        }
    })()

    msgContent.push({
        type: 'text' as const,
        text: `${ctx.message.from.first_name}`
            + replyText
            + (ctx.message.text || ctx.message.caption || ctx.message.sticker?.emoji || '')
    })

    const tgFile = (() => {
        if (ctx.message.photo) {
            return ctx.message.photo?.at(-1);
        } else {
            return ctx.message.sticker
        }
    })()

    if (tgFile) {
        const replyIsMediaGroup = !!(ctx.message.photo && ctx.message?.media_group_id);
        if (ctx.message?.sticker?.is_video || ctx.message?.sticker?.is_animated) {
            (msgContent[0] as ChatCompletionContentPartText).text += ' ([system] can not get video sticker, only thumbnail image) (I send a sticker)';
        } else {
            (msgContent[0] as ChatCompletionContentPartText).text
                += ('(I send ' + (replyIsMediaGroup ? 'some ' : 'a ')
                    + (ctx.message.photo ? 'picture' : 'sticker')
                    + (replyIsMediaGroup ? 's' : '') + ')')
        }


        // 当 global.asynchronousFileSaveMsgIdList 有值时，表示正在保存文件，等待列表清空
        while (global.asynchronousFileSaveMsgIdList.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const firstMsg = await getMessage(ctx.message.chat.id, ctx.message.message_id);

        if (firstMsg?.file) {
            const fileList = [firstMsg.file];

            for (const replyId of (JSON.parse(firstMsg.replies))) {
                const msg = await getMessage(ctx.message.chat.id, replyId);
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

    chatContents.push({
        role: 'user' as const,
        content: msgContent
    })

    return chatContents;
}

async function sendMsgToOpenAIWithRetry(chatContents: MessageContent[]): Promise<Stream<ChatCompletionChunk> | ChatCompletion | GenerateContentStreamResult> {
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

    const timeout = 85000; // 85 seconds timeout

    async function attempt(): Promise<Stream<ChatCompletionChunk> | ChatCompletion | GenerateContentStreamResult> {
        return new Promise<Stream<ChatCompletionChunk> | ChatCompletion | GenerateContentStreamResult>((resolve, reject) => {
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

    // 最多请求 3 次
    let retries = 3;
    while (retries--) {
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

    throw new Error('Maximum retries exceeded');
}

export const reply = async (ctx: Context, retryMenu: Menu<Context>, options?: {
    mention?: boolean
}) => {
    if (!ctx.message || !ctx.chat) { return; }

    // 如果没有被提及，不需要回复
    if (!(checkIfMentioned(ctx) || options?.mention)) { return; }

    // 如果是图片组，后面的图片不需要重复回复
    if (
        ctx.message.photo &&
        global.mediaGroupIdTemp.chatId === ctx.chat.id &&
        global.mediaGroupIdTemp.messageId !== ctx.message.message_id &&
        global.mediaGroupIdTemp.mediaGroupId === ctx.update?.message?.media_group_id
    ) {
        return;
    }

    ctx.api.sendChatAction(ctx.chat.id, 'typing');

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

        await ctx.api.editMessageText(chatId, messageId, msg);
        currentMsg = msg;
    }
    Object.assign(ctx, { update_id: ctx.update.update_id });

    const chatContents = await generalContext(ctx);

    try {
        const stream: Stream<ChatCompletionChunk> | ChatCompletion | GenerateContentStreamResult = await sendMsgToOpenAIWithRetry(chatContents);

        let buffer = '';

        let timeTemp = Date.now();

        const handleBuffer = async () => {
            // 每 500ms 更新一次
            if (buffer.length && Date.now() - timeTemp > 500) {
                await ctx.api.sendChatAction(chatId, 'typing');
                await addReply(buffer);
                buffer = '';  // 清空缓冲区
                timeTemp = Date.now();
            }
        }

        if (!global.currentModel.startsWith('gemini') || !process.env.GEMINI_API_KEY) {
            if (stream instanceof Stream) {
                for await (const chunk of (stream as Stream<ChatCompletionChunk>)) {
                    const content = chunk.choices[0]?.delta?.content;
                    if (content) {
                        buffer += content;

                        await handleBuffer();
                    }
                }
            } else {
                const content = (stream as ChatCompletion).choices[0]?.message.content;
                buffer += content;
            }

        } else {
            for await (const chunk of (stream as GenerateContentStreamResult).stream) {
                const chunkText = chunk.text();

                if (chunkText) {
                    buffer += chunkText;
                }

                await handleBuffer();
            }
        }

        // 如果缓冲区中仍有内容，最后一次性追加
        if (buffer.length) {
            await addReply(buffer);
        }

        const finalMsg = currentMsg === 'Processing...' ? '寄了' : currentMsg.slice(0, -14)

        saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: replyDate,
            userName: botUserName,
            message: finalMsg,
            replyToId: ctx.message.message_id,
        });

        await ctx.api.editMessageText(chatId, messageId, finalMsg, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error("chat 出错:", error);

        saveMessage({
            chatId,
            messageId,
            userId: botUserId,
            date: replyDate,
            userName: botUserName,
            message: currentMsg,
            replyToId: ctx.message.message_id,
        });

        const errorMsg = currentMsg + '\n' + (error instanceof Error ? error.message : 'Unknown error');
        const msg = errorMsg.length > 1000 ? (errorMsg.slice(0, 1000) + '...') : errorMsg
        try {
            await ctx.api.editMessageText(chatId, messageId, msg, {
                reply_markup: retryMenu
            })
        } catch (error) {
            console.error("尝试更新错误信息失败：", error);
            setTimeout(async () => {
                try {
                    await ctx.api.editMessageText(chatId, messageId, msg, {
                        reply_markup: retryMenu
                    })
                } catch (error) {
                    console.error("尝试等待 15s 更新错误信息失败：", error);
                }
            }, 15000);
        }
    }
}

export const replyChat = (bot: Bot, menus: Menus) => {
    bot.on(['msg:text', 'msg:photo', 'msg:sticker'], (ctx) => reply(ctx, menus.retryMenu));
}