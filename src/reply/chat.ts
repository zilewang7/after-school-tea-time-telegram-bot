import dotenv from 'dotenv'
import { Bot, Context } from "grammy";
import { Menu } from '@grammyjs/menu';
import { Stream } from "openai/streaming.mjs";
import { ChatCompletion, ChatCompletionChunk } from "openai/resources/index.mjs";
import { EnhancedGenerateContentResponse, GenerateContentStreamResult, GroundingMetadata } from '@google/generative-ai';
import telegramifyMarkdown from 'telegramify-markdown';
import { MessageContent } from '../openai/index';
import { Menus } from '../cmd/menu';
import { checkIfMentioned } from "../util";
import { getMessage, saveMessage } from "../db";
import { sendMsgToOpenAI } from "../openai";
import { generalContext } from './general-context';
import { dealChatCommand } from './helper';

dotenv.config();

const botUserId = Number(process.env.BOT_USER_ID)
const botUserName = process.env.BOT_NAME


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
    const replyDate = new Date(currentReply.date * 1000);
    let currentMsg = currentReply.text;

    // 追加内容
    const addReply = async (content: string) => {
        const lastMsg = currentMsg.slice(0, -14);
        const msg = lastMsg + content + '\nProcessing...';

        await ctx.api.editMessageText(chatId, messageId, msg);
        currentMsg = msg;
    }
    Object.assign(ctx, { update_id: ctx.update.update_id });


    const msg = await getMessage(ctx.chat.id, ctx.message.message_id);
    if (!msg) {
        throw new Error('读取消息失败');
    }
    const chatContents = await generalContext(msg);

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

        let finalResponse: EnhancedGenerateContentResponse | undefined;
        let groundingMetadatas: GroundingMetadata[] = [];

        if (!global.currentModel.startsWith('gemini') || !process.env.GEMINI_API_KEY) {
            if ((stream as Stream<ChatCompletionChunk>)?.controller) {
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

            finalResponse = await (stream as GenerateContentStreamResult).response;
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

        let tgMsg = telegramifyMarkdown(finalMsg, 'escape').replace(/(?<!\\)([-|])/g, '\\$1');

        finalResponse?.candidates?.forEach(candidate => {
            candidate.groundingMetadata && groundingMetadatas.push(candidate.groundingMetadata);
        })
        // @ts-ignore
        finalResponse?.candidates?.[undefined]?.groundingMetadata?.webSearchQueries && groundingMetadatas.push(finalResponse.candidates[undefined].groundingMetadata); // 谷歌你的 gemini api tmd 返回的什么玩意

        const extractUrls = (content?: string): string[] => {
            if (!content) return [];

            // 使用单个正则表达式匹配所有 href 属性
            const hrefRegex = /href=["'](.*?)["']/g;
            const matches = [...content.matchAll(hrefRegex)];

            return matches.map(match => match[1]).filter(url => url !== undefined);
        };

        if (groundingMetadatas.length) {
            console.log('groundingMetadatas:', JSON.stringify(groundingMetadatas));
        }
        groundingMetadatas.forEach((groundingMetadata, index) => {
            tgMsg += '\n*GoogleSearch*\n**>';

            const urls = extractUrls(groundingMetadata.searchEntryPoint?.renderedContent);

            tgMsg += groundingMetadata.webSearchQueries.map((text, index) => `[${text.replace(/(?<!\\)([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}](${urls[index]})`).join(' \\| ');
            // @ts-ignore 谷歌你定义的 groundingChuncks，返回的 groundingChunks，你是这个👍
            groundingMetadata.groundingChunks?.forEach(({ web }, index) => {
                tgMsg += `\n>\\[${index + 1}\\] [${web?.title.replace(/(?<!\\)([_*[\]()~`>#+-=|{}.!])/g, '\\$1')}](${web?.uri})`;
            });
            (groundingMetadatas.length === (index + 1)) && (tgMsg += '||');
        })

        console.log('tgMsg:', tgMsg);

        await ctx.api.editMessageText(chatId, messageId, tgMsg, {
            parse_mode: 'MarkdownV2'
        });
    } catch (error) {
        console.error("chat 出错:", error);

        if (currentMsg !== 'Processing...') {
            saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: currentMsg.length > 14 ? currentMsg.slice(0, -14) : currentMsg,
                replyToId: ctx.message.message_id,
            });
        }

        const errorMsg = currentMsg + '\n' + (error instanceof Error ? error.message : 'Unknown error');
        const msg = errorMsg.length > 4000 ? (errorMsg.slice(0, 4000) + '...') : errorMsg
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
    bot.on(['msg:text', 'msg:photo', 'msg:sticker'], async (ctx, next) => {
        next();

        setTimeout(async () => {
            // 当 global.asynchronousFileSaveMsgIdList 有值时，表示正在保存文件，等待列表清空
            while (global.asynchronousFileSaveMsgIdList.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const useChatCommand = await dealChatCommand(ctx);

            reply(ctx, menus.retryMenu, {
                mention: useChatCommand
            })
        });
    });
}