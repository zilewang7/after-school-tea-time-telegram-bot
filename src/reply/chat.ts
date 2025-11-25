import { Api, Bot, Context } from "grammy";
import { Menu } from '@grammyjs/menu';
import { Stream } from "openai/streaming";
import { ChatCompletion, ChatCompletionChunk } from "openai/resources";
import { EnhancedGenerateContentResponse, GenerateContentStreamResult, GroundingMetadata } from '@google/generative-ai';
import telegramifyMarkdown from 'telegramify-markdown';
import { MessageContent } from '../openai';
import { Menus } from '../cmd/menu';
import { checkIfMentioned, safeTextV2 } from "../util";
import { getMessage, saveMessage } from "../db";
import { sendMsgToOpenAI } from "../openai";
import { generalContext } from './general-context';
import { dealChatCommand } from './helper';
import {
    getCurrentModel,
    getMediaGroupIdTemp,
    getRateLimiterEntry,
    setRateLimiterEntry,
    getAsyncFileSaveMsgIdList,
} from '../state';
import { DeepSeekChatCompletionChunk, ExtendedGroundingMetadata } from '../types';

const botUserId = Number(process.env.BOT_USER_ID)
const botUserName = process.env.BOT_NAME


async function sendMsgToOpenAIWithRetry(chatContents: MessageContent[]): Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>> {
    // log message contents (truncate image URLs for readability)
    type LogContent = { type: 'text'; text: string } | { type: 'image_url'; urlLength: number };
    chatContents.map(chatContent => {
        const transContents: Array<{ role: string; content: LogContent[] } | MessageContent> = [];
        if (chatContent.role === 'user' && chatContent.content instanceof Array) {
            const transContent: LogContent[] = [];
            chatContent.content.forEach((content) => {
                if (content.type === 'image_url') {
                    transContent.push({
                        type: 'image_url',
                        urlLength: content.image_url.url.length
                    });
                } else {
                    transContent.push(content);
                }
            });
            transContents.push({
                role: 'user',
                content: transContent
            });
        } else {
            transContents.push(chatContent);
        }
        console.log(chatContent.role, ...transContents);
    })

    const timeout = 85000; // 85 seconds timeout

    async function attempt(): Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>> {
        return new Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>>((resolve, reject) => {
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

// rate-limited edit message per chatId
async function rateLimitedEdit(api: Api, ...args: Parameters<Api["editMessageText"]>) {
    const [chatId, ...rest] = args;

    const now = Date.now();
    let limiter = getRateLimiterEntry(chatId);
    if (!limiter) {
        limiter = { count: 0, startTimestamp: now, lastEditTimestamp: now };
        setRateLimiterEntry(chatId, limiter);
    }
    // reset every minute
    if (now - limiter.startTimestamp >= 60000) {
        limiter.count = 0;
        limiter.startTimestamp = now;
        limiter.lastEditTimestamp = now;
    }
    let delay = 0;
    if (limiter.count < 10) {
        const nextTime = limiter.lastEditTimestamp + 500;
        delay = Math.max(0, nextTime - now);
    } else {
        const remainingQuota = 20 - limiter.count || 1;
        const remainingTime = 60000 - (now - limiter.startTimestamp);
        const dynamicDelay = remainingTime / remainingQuota;
        const nextTime = limiter.lastEditTimestamp + dynamicDelay;
        delay = Math.max(0, nextTime - now);
    }
    if (delay) {
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    const result = await api.editMessageText(chatId, ...rest);
    limiter.count++;
    limiter.lastEditTimestamp = Date.now();
    return result;
}

export const reply = async (ctx: Context, retryMenu: Menu<Context>, options?: {
    mention?: boolean
}) => {
    if (!ctx.message || !ctx.chat) { return; }

    // 如果没有被提及，不需要回复
    if (!checkIfMentioned(ctx, options?.mention)) { return; }

    // skip duplicate replies for media groups
    const mediaGroupTemp = getMediaGroupIdTemp();
    if (
        ctx.message.photo &&
        mediaGroupTemp.chatId === ctx.chat.id &&
        mediaGroupTemp.messageId !== ctx.message.message_id &&
        mediaGroupTemp.mediaGroupId === ctx.update?.message?.media_group_id
    ) {
        return;
    }

    // 设置一个定时器每5秒发送一次 typing 状态
    let typingInterval: NodeJS.Timeout | undefined;
    const startTyping = (chatId: number) => {
        ctx.api.sendChatAction(chatId, 'typing');
        typingInterval = setInterval(() => {
            ctx.api.sendChatAction(chatId, 'typing');
        }, 5000);
    };

    startTyping(ctx.chat.id);

    const currentReply = await ctx.reply('Processing...', {
        reply_parameters: {
            message_id: ctx.message.message_id
        }
    });
    const messageId = currentReply.message_id;
    const chatId = currentReply.chat.id;
    const replyDate = new Date(currentReply.date * 1000);
    let currentMsg = currentReply.text;
    let tinkingMsg = "";

    // 追加内容
    const addReply = async (content: string) => {
        const lastMsg = currentMsg.slice(0, -14);
        const msg = lastMsg + content + '\nProcessing...';


        if (tinkingMsg) {
            let msgWithTingking = '>'
                + tinkingMsg.split('\n').map(text => safeTextV2(text)).join('\n>')
                + '\n' + safeTextV2(msg);

            await rateLimitedEdit(ctx.api, chatId, messageId, msgWithTingking, {
                parse_mode: 'MarkdownV2'
            });
        } else {
            await rateLimitedEdit(ctx.api, chatId, messageId, msg);
        }

        currentMsg = msg;
    }
    Object.assign(ctx, { update_id: ctx.update.update_id });


    const msg = await getMessage(ctx.chat.id, ctx.message.message_id);
    if (!msg) {
        throw new Error('读取消息失败');
    }
    const chatContents = await generalContext(msg);

    try {
        const stream: Awaited<ReturnType<typeof sendMsgToOpenAI>> = await sendMsgToOpenAIWithRetry(chatContents);

        let buffer = '';
        let thinkingBuffer = '';

        let timeTemp = Date.now();

        const handleBuffer = async () => {
            // 每 500ms 更新一次
            if ((buffer.length || thinkingBuffer.length) && Date.now() - timeTemp > 500) {
                await addReply(buffer);
                buffer = '';  // 清空缓冲区
                thinkingBuffer = '';  // 清空思考缓冲区
                timeTemp = Date.now();
            }
        }

        let finalResponse: EnhancedGenerateContentResponse | undefined;
        let groundingMetadatas: GroundingMetadata[] = [];
        const currentModel = getCurrentModel();

        if (!currentModel.startsWith('gemini') || !process.env.GEMINI_API_KEY) {
            if ((stream as unknown as Stream<ChatCompletionChunk>)?.controller) {
                for await (const chunk of (stream as unknown as Stream<DeepSeekChatCompletionChunk>)) {
                    const content = chunk.choices[0]?.delta?.content;
                    const reasoning_content = chunk.choices[0]?.delta?.reasoning_content;
                    if (reasoning_content) {
                        thinkingBuffer += reasoning_content;
                        tinkingMsg += reasoning_content;

                        await handleBuffer();
                    }


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

        let tgMsg = telegramifyMarkdown(finalMsg, 'escape');

        finalResponse?.candidates?.forEach(candidate => {
            candidate.groundingMetadata && groundingMetadatas.push(candidate.groundingMetadata);
        });
        // Handle Google API bug where candidates has 'undefined' as key
        const candidatesRecord = finalResponse?.candidates as unknown as Record<string, { groundingMetadata?: GroundingMetadata }> | undefined;
        const undefinedCandidate = candidatesRecord?.['undefined'];
        if (undefinedCandidate?.groundingMetadata?.webSearchQueries) {
            groundingMetadatas.push(undefinedCandidate.groundingMetadata);
        }

        // thinking 信息
        if (tinkingMsg.length) {
            tgMsg = '**>'
                + tinkingMsg.split('\n').map(text => safeTextV2(text)).join('\n>')
                + '||' + '\n' + tgMsg;
        }
        
        type Anchor = { href: string; text: string };
        const stripTags = (html?: string) => {
            if (!html) return '';
            return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        }
        const extractAnchors = (content?: string): Anchor[] => {
            if (!content) return [];

            // 提取 a 标签的 href 与 innerText
            // 支持带有嵌套标签的 anchor（innerHTML 里可能有 svg 等）
            const anchorRegex = /<a[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
            const matches = [...content.matchAll(anchorRegex)];
            return matches.map(match => ({ href: (match?.[1] ?? ''), text: stripTags(match?.[2] ?? '') }));
        };

        // 谷歌搜索接地信息
        if (groundingMetadatas.length) {
            console.log('groundingMetadatas:', JSON.stringify(groundingMetadatas));
        }
        groundingMetadatas.forEach((groundingMetadata, index) => {
            if (!groundingMetadata.webSearchQueries) return;

            // 过滤掉空 query
            const queries = (groundingMetadata.webSearchQueries || []).filter(q => q && q.toString().trim().length > 0).map(q => q.toString());
            if (!queries.length) return;

            tgMsg += '\n*GoogleSearch*\n**>';

            const anchors = extractAnchors(groundingMetadata.searchEntryPoint?.renderedContent);

            // 匹配策略（优先匹配 anchor text，其次尝试 href 包含 query，再以未使用的 anchor 作为回退）
            const used = new Set<number>();
            const matchedAnchors: (Anchor | undefined)[] = queries.map((q) => {
                const normQ = q.trim().toLowerCase();
                // match by anchor text
                for (let i = 0; i < anchors.length; i++) {
                    if (used.has(i)) continue;
                    const aText = (anchors[i]?.text ?? '').toLowerCase();
                    if (!aText) continue;
                    if (aText.includes(normQ) || normQ.includes(aText)) {
                        used.add(i);
                        return anchors[i];
                    }
                }

                // try match by href
                for (let i = 0; i < anchors.length; i++) {
                    if (used.has(i)) continue;
                    const href = (anchors[i]?.href ?? '').toLowerCase();
                    // check several variants: raw query, spaces replaced
                    if (href.includes(normQ) || href.includes(encodeURIComponent(normQ)) || href.includes(normQ.replace(/\s+/g, '+'))) {
                        used.add(i);
                        return anchors[i];
                    }
                }

                // fallback: pick first unused anchor
                for (let i = 0; i < anchors.length; i++) {
                    if (!used.has(i)) {
                        used.add(i);
                        return anchors[i];
                    }
                }

                return undefined;
            });

            tgMsg += queries.map((text, idx) => {
                const anchor = matchedAnchors[idx];
                if (anchor && anchor.href) {
                    return `[${safeTextV2(text)}](${anchor.href})`;
                }
                // 没有找到对应的链接时只显示纯文本（避免拼接 undefined 链接导致错误）
                return safeTextV2(text);
            }).join(' \\| ');
            // Handle Google SDK typo: type defines groundingChuncks but API returns groundingChunks
            const extendedMetadata = groundingMetadata as ExtendedGroundingMetadata;
            extendedMetadata.groundingChunks?.forEach(({ web }, chunkIndex) => {
                tgMsg += `\n>\\[${chunkIndex + 1}\\] [${safeTextV2(web?.title ?? '')}](${web?.uri ?? ''})`;
            });
            (groundingMetadatas.length === (index + 1)) && (tgMsg += '||');
        })

        console.log('tgMsg:', tgMsg);

        // 清除 typing 状态的定时器
        clearInterval(typingInterval);

        await rateLimitedEdit(ctx.api, chatId, messageId, tgMsg, {
            parse_mode: 'MarkdownV2'
        });
    } catch (error) {
        // 发生错误时也要清除定时器
        clearInterval(typingInterval);
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
            await rateLimitedEdit(ctx.api, chatId, messageId, msg, {
                reply_markup: retryMenu
            })
        } catch (error) {
            console.error("尝试更新错误信息失败：", error);
            setTimeout(async () => {
                try {
                    await rateLimitedEdit(ctx.api, chatId, messageId, msg, {
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
            // wait for async file saving to complete
            while (getAsyncFileSaveMsgIdList().length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const useChatCommand = await dealChatCommand(ctx);

            reply(ctx, menus.retryMenu, {
                mention: useChatCommand
            });
        });
    });
}