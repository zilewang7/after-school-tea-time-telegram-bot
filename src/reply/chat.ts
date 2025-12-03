import { Api, Bot, Context, InputFile } from "grammy";
import { Menu } from '@grammyjs/menu';
import { Stream } from "openai/streaming";
import { ChatCompletion, ChatCompletionChunk } from "openai/resources";
import telegramifyMarkdown from 'telegramify-markdown';
import { type GenerateContentResponse } from "@google/genai";
import { ChatContentPart, MessageContent, genAI } from '../openai';
import { Menus } from '../cmd/menu';
import { checkIfMentioned, safeTextV2 } from "../util";
import { getMessage, saveMessage } from "../db";
import { sendMsgToOpenAI } from "../openai";
import { generalContext } from './general-context';
import { dealChatCommand, dealPicbananaCommand } from './helper';
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

// Unified Gemini stream processing result
interface GeminiStreamResult {
    textContent: string;
    thinkingContent: string;
    imageDataList: Buffer[];
    finalResponse: any;
}

/**
 * Process Gemini stream with unified logic
 * Handles text, thinking content, and image data
 * Calls onUpdate periodically to update UI
 */
async function processGeminiStream(
    stream: AsyncIterable<GenerateContentResponse>,
    onUpdate?: (textBuffer: string, thinkingBuffer: string) => Promise<void>
): Promise<GeminiStreamResult> {
    let textContent = '';
    let thinkingContent = '';
    const imageDataList: Buffer[] = [];
    let finalResponse: any = null;

    let textBuffer = '';
    let thinkingBuffer = '';
    let lastUpdateTime = Date.now();
    const UPDATE_INTERVAL = 500; // Update every 500ms

    for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts;

        if (parts) {
            for (const part of parts) {
                // Check if this is thinking content
                if (part.thought) {
                    // This is thinking process (Thought Summary)
                    const thoughtText = part.text || '';
                    thinkingContent += thoughtText;
                    thinkingBuffer += thoughtText;
                } else if (part.text) {
                    // This is normal response content
                    textContent += part.text;
                    textBuffer += part.text;
                }

                // Collect image data
                if (part.inlineData?.data) {
                    // Convert base64 to Buffer
                    imageDataList.push(Buffer.from(part.inlineData.data, 'base64'));
                }
            }
        }

        finalResponse = chunk;

        // Call update callback periodically
        if (onUpdate && (textBuffer || thinkingBuffer) && Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
            await onUpdate(textBuffer, thinkingBuffer);
            textBuffer = '';
            thinkingBuffer = '';
            lastUpdateTime = Date.now();
        }
    }

    // Final update if there's remaining buffer
    if (onUpdate && (textBuffer || thinkingBuffer)) {
        await onUpdate(textBuffer, thinkingBuffer);
    }

    return {
        textContent,
        thinkingContent,
        imageDataList,
        finalResponse
    };
}

// Handle /picbanana command using unified flow
export async function handlePicbananaCommand(ctx: Context, commandData: { prompt: string; referenceImages: string[] }, retryMenu: Menu<Context>) {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    if (!genAI) {
        await ctx.reply("Gemini API Key 未配置", { reply_parameters: { message_id: userMessageId } });
        return;
    }

    // Send typing action
    await ctx.api.sendChatAction(chatId, 'typing');

    const processingReply = await ctx.reply('Processing...', {
        reply_parameters: {
            message_id: ctx.message.message_id
        }
    });

    let currentDisplayText = 'Processing...';
    let accumulatedText = '';
    let accumulatedThinking = '';

    // Setup typing interval
    let typingInterval: NodeJS.Timeout | undefined;
    const startTyping = () => {
        ctx.api.sendChatAction(chatId, 'typing');
        typingInterval = setInterval(() => {
            ctx.api.sendChatAction(chatId, 'typing');
        }, 5000);
    };
    startTyping();

    try {
        console.log('[picbanana] input', {
            promptLength: commandData.prompt.length,
            referenceImages: commandData.referenceImages.length
        });

        // Build message contents using unified format
        const contentParts: ChatContentPart[] = [
            { type: 'text', text: commandData.prompt }
        ];

        commandData.referenceImages.forEach((data) => {
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:image/png;base64,${data}`
                }
            });
        });

        const messageContents: MessageContent[] = [
            {
                role: 'user',
                content: contentParts
            }
        ];

        // Use unified retry flow with model override
        const stream = await sendMsgToOpenAIWithRetry(messageContents, {
            model: 'gemini-3-pro-image-preview'
        });

        // Process stream with unified logic and real-time updates
        const result = await processGeminiStream(
            stream as AsyncIterable<GenerateContentResponse>,
            async (textBuffer: string, thinkingBuffer: string) => {
                accumulatedText += textBuffer;
                accumulatedThinking += thinkingBuffer;

                // Format display message with proper escaping
                let displayMsg = '';
                if (accumulatedThinking) {
                    displayMsg = '>' + accumulatedThinking.split('\n').map(text => safeTextV2(text)).join('\n>') + '\n';
                }
                if (accumulatedText) {
                    displayMsg += safeTextV2(accumulatedText);
                }
                if (displayMsg) {
                    displayMsg += '\nProcessing\\.\\.\\.';
                    currentDisplayText = displayMsg;

                    try {
                        await ctx.api.editMessageText(chatId, processingReply.message_id, displayMsg, {
                            parse_mode: 'MarkdownV2'
                        });
                    } catch (error: unknown) {
                        // Silently ignore all update errors during streaming to not interrupt the flow
                        // The final result will be shown anyway
                    }
                }
            }
        );

        clearInterval(typingInterval);

        const { textContent, thinkingContent, imageDataList, finalResponse } = result;
        const modelParts = finalResponse?.candidates?.[0]?.content?.parts;

        console.log('[picbanana] response', {
            hasText: Boolean(textContent),
            hasThinking: Boolean(thinkingContent),
            imageCount: imageDataList.length,
            imageLengths: imageDataList.map(buf => buf.length)
        });

        // Prepare final message for processing message
        let finalMessage = '';
        if (thinkingContent) {
            finalMessage = '**>' + thinkingContent.split('\n').map(text => safeTextV2(text)).join('\n>') + '||';
            if (textContent) {
                finalMessage += '\n' + telegramifyMarkdown(textContent, 'escape');
            }
        } else if (textContent) {
            finalMessage = telegramifyMarkdown(textContent, 'escape');
        }

        const hasContent = Boolean(finalMessage);

        if (imageDataList.length > 0) {
            // Has image - send pure image without caption
            const buffer = imageDataList[0];
            if (!buffer) {
                throw new Error('Image data missing from generation response');
            }

            // Send pure image
            const sentMsg = await ctx.api.sendPhoto(chatId, new InputFile(buffer as any), {
                reply_parameters: { message_id: userMessageId }
            });

            // Update processing message with final content or delete if no content
            if (hasContent) {
                try {
                    await ctx.api.editMessageText(chatId, processingReply.message_id, finalMessage, {
                        parse_mode: 'MarkdownV2'
                    });
                } catch (error) {
                    console.error('Failed to update processing message:', error);
                }
            } else {
                // Only delete if no thinking, no text, and no error
                try {
                    await ctx.api.deleteMessage(chatId, processingReply.message_id);
                } catch (error) {
                    console.error('Failed to delete processing message:', error);
                }
            }

            // Save image to database
            await saveMessage({
                chatId,
                messageId: sentMsg.message_id,
                userId: botUserId,
                date: new Date(),
                userName: botUserName,
                message: textContent || thinkingContent || '[IMAGE]',
                replyToId: userMessageId,
                fileBuffer: buffer,
                modelParts,
            });

            // Save processing message to database if it has content
            if (hasContent) {
                await saveMessage({
                    chatId,
                    messageId: processingReply.message_id,
                    userId: botUserId,
                    date: new Date(),
                    userName: botUserName,
                    message: textContent || thinkingContent,
                    replyToId: userMessageId,
                });
            }
        } else if (hasContent) {
            // No image but has text - update the processing message
            await ctx.api.editMessageText(chatId, processingReply.message_id, finalMessage, {
                parse_mode: 'MarkdownV2'
            });

            // Save to database
            await saveMessage({
                chatId,
                messageId: processingReply.message_id,
                userId: botUserId,
                date: new Date(),
                userName: botUserName,
                message: textContent || thinkingContent,
                replyToId: userMessageId,
                modelParts,
            });
        } else {
            // No image, no text, no thinking - show error
            throw new Error('未找到图片或文本数据');
        }
    } catch (error) {
        clearInterval(typingInterval);
        console.error('Error in handlePicbananaCommand:', error);
        const errorMsg = (currentDisplayText !== 'Processing...' ? currentDisplayText + '\n\n' : '') +
            '❌ 错误：' + (error instanceof Error ? error.message : String(error));

        try {
            await ctx.api.editMessageText(chatId, processingReply.message_id, errorMsg, {
                reply_markup: retryMenu
            });
        } catch (editError) {
            console.error('Failed to edit error message:', editError);
        }
    }
}


async function sendMsgToOpenAIWithRetry(
    chatContents: MessageContent[],
    options?: Parameters<typeof sendMsgToOpenAI>[1]
): Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>> {
    // log message contents (truncate image URLs for readability)
    type LogContent = { type: 'text'; text: string } | { type: 'image_url'; urlLength: number };
    chatContents.forEach(chatContent => {
        const normalize = (parts: Array<ChatContentPart>): LogContent[] => parts.map(part => {
            if (part.type === 'image_url') {
                return { type: 'image_url', urlLength: part.image_url.url.length };
            }
            return {
                type: 'text',
                text: part.text,
            };
        });

        if (chatContent.role === 'user' && chatContent.content instanceof Array) {
            console.log('user', { content: normalize(chatContent.content) });
        } else if (chatContent.role === 'assistant' && Array.isArray(chatContent.content)) {
            console.log('assistant', { content: normalize(chatContent.content) });
        } else {
            console.log(chatContent.role, chatContent);
        }
    })

    const init_timeout = 850000; // 85 seconds timeout
    const timeout_increment = 30000; // increase by 30 seconds on each retry

    async function attempt(timeout: number): Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>> {
        return new Promise<Awaited<ReturnType<typeof sendMsgToOpenAI>>>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout'));
            }, timeout);

            sendMsgToOpenAI(chatContents, options)
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
        const timeout = init_timeout + (3 - retries - 1) * timeout_increment;
        try {
            const stream = await attempt(timeout);
            return stream; // If attempt is successful, return the stream
        } catch (error) {
            const shouldRetry =
                (error instanceof Error && error.message === 'Timeout') ||
                (error instanceof Error && error.message.includes('429')) ||
                (error instanceof Error && error.message.toLowerCase().includes('rate limit'));

            if (shouldRetry && retries > 0) {
                const waitTime = error instanceof Error && error.message.includes('429') ? 5000 : 1000;
                console.log(`Retrying due to ${error instanceof Error ? error.message : 'error'}... (${retries} retries left, waiting ${waitTime}ms)`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
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
    const processingText = 'Processing...';
    const processingSuffix = `\n${processingText}`;
    const stripProcessing = (text?: string): string => {
        if (!text) {
            return '';
        }

        if (text.endsWith(processingSuffix)) {
            return text.slice(0, -processingSuffix.length);
        }

        if (text.endsWith(processingText)) {
            return text.slice(0, -processingText.length);
        }

        return text;
    };

    let currentMsg = currentReply.text || processingText;
    let tinkingMsg = "";
    let latestText = stripProcessing(currentMsg);

    // 追加内容
    const addReply = async (content: string) => {
        const lastMsg = stripProcessing(currentMsg);
        const msg = lastMsg + content + processingSuffix;


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
        latestText = stripProcessing(msg);
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

        let finalResponse: any | undefined;
        let groundingMetadatas: any[] = [];
        const model = getCurrentModel();
        const isGeminiModel = model.startsWith('gemini') && genAI;

        if (!isGeminiModel) {
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
            // Gemini models - use unified stream processing
            const result = await processGeminiStream(
                stream as AsyncIterable<GenerateContentResponse>,
                async (textBuffer: string, thinkingBuffer: string) => {
                    buffer += textBuffer;
                    tinkingMsg += thinkingBuffer;
                    await handleBuffer();
                }
            );

            finalResponse = result.finalResponse;

            // Attach collected image data
            if (result.imageDataList.length > 0) {
                finalResponse.imageDataList = result.imageDataList;
            }
        }

        // 如果缓冲区中仍有内容，最后一次性追加
        if (buffer.length) {
            await addReply(buffer);
        }

        const modelParts = finalResponse?.candidates?.[0]?.content?.parts;

        const responseText = stripProcessing(currentMsg) || latestText;
        const hasResponseText = Boolean(responseText && responseText.trim().length);
        let tgMsg = hasResponseText ? telegramifyMarkdown(responseText, 'escape') : '';

        finalResponse?.candidates?.forEach((candidate: any) => {
            candidate.groundingMetadata && groundingMetadatas.push(candidate.groundingMetadata);
        });
        // Handle Google API bug where candidates has 'undefined' as key
        const candidatesRecord = finalResponse?.candidates as unknown as Record<string, { groundingMetadata?: any }> | undefined;
        const undefinedCandidate = candidatesRecord?.['undefined'];
        if (undefinedCandidate?.groundingMetadata?.webSearchQueries) {
            groundingMetadatas.push(undefinedCandidate.groundingMetadata);
        }

        // thinking 信息
        if (tinkingMsg.length) {
            const thinkingSection = '**>'
                + tinkingMsg.split('\n').map(text => safeTextV2(text)).join('\n>')
                + '||';
            tgMsg = tgMsg ? `${thinkingSection}\n${tgMsg}` : thinkingSection;
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
        if (groundingMetadatas.length && tgMsg) {
            console.log('groundingMetadatas:', JSON.stringify(groundingMetadatas));
        }
        groundingMetadatas.forEach((groundingMetadata, index) => {
            if (!tgMsg) {
                return;
            }
            if (!groundingMetadata.webSearchQueries) return;

            // 过滤掉空 query
            const queries = (groundingMetadata.webSearchQueries || []).filter((q: any) => q && q.toString().trim().length > 0).map((q: any) => q.toString());
            if (!queries.length) return;

            tgMsg += '\n*GoogleSearch*\n**>';

            const anchors = extractAnchors(groundingMetadata.searchEntryPoint?.renderedContent);

            // 匹配策略（优先匹配 anchor text，其次尝试 href 包含 query，再以未使用的 anchor 作为回退）
            const used = new Set<number>();
            const matchedAnchors: (Anchor | undefined)[] = queries.map((q: any) => {
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

            tgMsg += queries.map((text: any, idx: any) => {
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

        // 检查是否有生成的图片
        const imageDataList = finalResponse?.imageDataList || [];
        const hasImage = imageDataList.length > 0;

        if (hasImage) {
            console.log('[chat-image] model returned image', {
                model,
                imageCount: imageDataList.length,
                imageLengths: imageDataList.map((buffer: Buffer) => buffer.length),
                hasTextContent: Boolean(tgMsg),
                textContentLength: tgMsg ? tgMsg.length : 0,
                responseTextLength: responseText ? responseText.length : 0
            });

            // 发送纯图片，不带 caption
            const photoBuffer = imageDataList[0];
            if (!photoBuffer) {
                throw new Error('Image data missing from response');
            }

            const sentMsg = await ctx.api.sendPhoto(chatId, new InputFile(photoBuffer as any), {
                reply_parameters: {
                    message_id: ctx.message.message_id
                }
            });

            // Update processing message with final content or delete if no content
            const hasContent = Boolean(tgMsg);
            if (hasContent) {
                try {
                    await rateLimitedEdit(ctx.api, chatId, messageId, tgMsg, {
                        parse_mode: 'MarkdownV2'
                    });
                } catch (error) {
                    console.error('Failed to update processing message:', error);
                }
            } else {
                // Only delete if no thinking, no text, and no error
                try {
                    await ctx.api.deleteMessage(chatId, messageId);
                } catch (error) {
                    console.error('Failed to delete processing message:', error);
                }
            }

            // 保存图片消息到数据库
            await saveMessage({
                chatId,
                messageId: sentMsg.message_id,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: responseText || (tinkingMsg ? tinkingMsg : '[IMAGE]'),
                replyToId: ctx.message.message_id,
                fileBuffer: photoBuffer,
                modelParts: modelParts ?? undefined,
            });

            // 保存 processing 消息到数据库（如果有内容）
            if (hasContent) {
                const messageToSave = responseText || (tinkingMsg ? tinkingMsg : '');
                await saveMessage({
                    chatId,
                    messageId,
                    userId: botUserId,
                    date: replyDate,
                    userName: botUserName,
                    message: messageToSave,
                    replyToId: ctx.message.message_id,
                    modelParts: modelParts ?? undefined,
                });
            }

        } else {
            // 没有图片，使用原来的方式更新消息
            const safeFallback = telegramifyMarkdown('寄了', 'escape');
            const textToSend = tgMsg || safeFallback;
            const useRetryButton = textToSend === safeFallback;

            await rateLimitedEdit(ctx.api, chatId, messageId, textToSend, {
                parse_mode: 'MarkdownV2',
                ...(useRetryButton ? { reply_markup: retryMenu } : {})
            });

            const messageToSave = responseText || (tinkingMsg ? tinkingMsg : '寄了');
            console.log('[chat-text]', { model, messageLength: messageToSave.length });
            await saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: messageToSave,
                replyToId: ctx.message.message_id,
                modelParts: modelParts ?? undefined,
            });
        }
    } catch (error) {
        // 发生错误时也要清除定时器
        clearInterval(typingInterval);
        console.error("chat 出错:", error);

        const strippedMsg = stripProcessing(currentMsg);
        if (strippedMsg) {
            await saveMessage({
                chatId,
                messageId,
                userId: botUserId,
                date: replyDate,
                userName: botUserName,
                message: strippedMsg,
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

            // 检查是否是 /picbanana 命令
            const picbananaCommand = await dealPicbananaCommand(ctx);
            if (picbananaCommand) {
                // 独立处理 /picbanana 命令，不走聊天流程
                await handlePicbananaCommand(ctx, picbananaCommand, menus.retryMenu);
                return;
            }

            const useChatCommand = await dealChatCommand(ctx);

            reply(ctx, menus.retryMenu, {
                mention: useChatCommand
            });
        });
    });
}
