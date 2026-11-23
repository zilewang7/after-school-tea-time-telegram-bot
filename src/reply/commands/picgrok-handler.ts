/**
 * Picgrok command handler
 * Handles /picgrok image generation: one xAI images call, delivered through the
 * reply pipeline like /picbanana and /picgpt.
 *
 * The xAI endpoint is the OpenAI-compatible images API, not a chat platform, so
 * there is no stream and no platform here: the handler generates one picture,
 * downloads its bytes and hands them to sendFinalResponse. That is what gives the
 * reply its placeholder, stored version/message row, context entry, reply
 * metrics, retry button and reaction/`#N` normalization.
 */
import type { Context } from 'grammy';
import OpenAI from 'openai';
import { GROK_IMAGE_MODEL } from '../../config/models.js';
import { to, isErr } from '../../shared/result.js';
import type { AIResponse } from '../../ai/types.js';
import { sniffMediaMime } from '../../ai/image-generation/image-mime.js';
import { type AccessTier } from '../../services/access-tier.js';
import { markRequestStarted } from '../../services/reply-metrics-draft.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';
import {
    createChatContext,
    sendFinalResponse,
    handleResponseError,
    type ChatContext,
} from './../response-handler.js';

/** A generated picture, as bytes the delivery pipeline can send and store */
export type PicgrokImageGenerator = (prompt: string, signal: AbortSignal) => Promise<Buffer>;

/** One generation's wall-clock budget; the stop button aborts earlier */
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

/** Telegram's photo limit is 10MB; a runaway body is refused here instead of being held twice */
const MAX_RESULT_IMAGE_BYTES = 20 * 1024 * 1024;

/** How to produce the picture; a test swaps it out instead of calling xAI */
export interface PicgrokGenerationDependencies {
    readonly generateImage?: PicgrokImageGenerator;
}

/** Picgrok command data: the prompt, and nothing else (this endpoint takes no reference images) */
export interface PicgrokCommandData {
    prompt: string;
}

const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * The xAI client, built on first use: constructing it at import time would make
 * every importer fail when GROK_API_KEY is unset (offline tests, a rollback).
 */
let grokImageClient: OpenAI | null = null;

const grokImageClientOf = (): OpenAI => {
    const apiKey = process.env.GROK_API_KEY;
    if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('生成图片失败：没有配置 Grok 接口（GROK_API_KEY）');
    }
    const baseURL = process.env.GROK_API_URL;
    if (baseURL === undefined || baseURL.trim() === '') {
        throw new Error('生成图片失败：没有配置 Grok 接口地址（GROK_API_URL）');
    }
    grokImageClient ??= new OpenAI({ baseURL, apiKey });
    return grokImageClient;
};

/** The picture behind a result URL, bounded and abortable */
const downloadImageBytes = async (url: string, signal: AbortSignal): Promise<Buffer> => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`生成图片失败：下载结果图失败（HTTP ${response.status}）`);
    }
    const declaredBytes = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESULT_IMAGE_BYTES) {
        throw new Error('生成图片失败：结果图超过 20MB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
        throw new Error('生成图片失败：结果图是空的');
    }
    if (bytes.length > MAX_RESULT_IMAGE_BYTES) {
        throw new Error('生成图片失败：结果图超过 20MB');
    }
    // Some CDNs answer an image URL as application/octet-stream: trust the
    // bytes, the same sniff the delivery uses, not the header
    if (sniffMediaMime(bytes) === null) {
        throw new Error(`生成图片失败：结果不是可识别的图片（${response.headers.get('content-type') ?? '未知类型'}）`);
    }
    return bytes;
};

/**
 * One xAI image generation. The endpoint answers either base64 bytes or a URL;
 * both paths end in a Buffer. Every failure is a readable Chinese error.
 */
export const generatePicgrokImage: PicgrokImageGenerator = async (
    prompt: string,
    signal: AbortSignal
): Promise<Buffer> => {
    const deadline = AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS);
    const attemptSignal = AbortSignal.any([signal, deadline]);

    const generated = await to(
        grokImageClientOf().images.generate(
            { model: GROK_IMAGE_MODEL, prompt, n: 1 },
            { signal: attemptSignal }
        )
    );
    if (isErr(generated)) {
        // A timeout reads differently from a stop, and a stop is handled as one
        if (deadline.aborted && !signal.aborted) {
            throw new Error('生成图片失败：请求超时（120 秒）');
        }
        throw new Error(`生成图片失败：${errorMessageOf(generated[0])}`);
    }

    const item = generated[1].data?.[0];
    if (item === undefined) throw new Error('生成图片失败：xAI 没有返回图片');
    if (typeof item.b64_json === 'string' && item.b64_json !== '') {
        return Buffer.from(item.b64_json, 'base64');
    }
    if (typeof item.url === 'string' && item.url !== '') {
        return downloadImageBytes(item.url, attemptSignal);
    }
    throw new Error('生成图片失败：xAI 没有返回图片');
};

/**
 * Generate the picture for an open reply attempt and deliver it through the
 * reply pipeline. Shared by the command and the retry path, so both end in the
 * same placeholder / version / buttons / metrics shape.
 */
export const runPicgrokGeneration = async (
    chatContext: ChatContext,
    prompt: string,
    dependencies: PicgrokGenerationDependencies = {}
): Promise<void> => {
    const { metrics } = chatContext.session;
    markRequestStarted(metrics);

    // The stop button may have landed between the placeholder and this call: the
    // reply then ends as a stop instead of starting a paid request
    if (chatContext.session.streamController.signal.aborted) {
        await handleResponseError(chatContext, new Error('Aborted'));
        return;
    }

    const generateImage = dependencies.generateImage ?? generatePicgrokImage;
    const generated = await to(
        generateImage(prompt, chatContext.session.streamController.signal)
    );
    if (isErr(generated)) {
        console.error('[picgrok] image generation failed:', generated[0]);
        await handleResponseError(chatContext, generated[0]);
        return;
    }
    const imageBytes = generated[1];
    if (imageBytes.length === 0) {
        await handleResponseError(chatContext, new Error('生成图片失败：返回了空图片'));
        return;
    }

    console.log('[picgrok] image generated', {
        promptLength: prompt.length,
        imageBytes: imageBytes.length,
    });

    // No text and no caption: the reply is the picture alone, as /picgrok always
    // answered. sendFinalResponse gives it the placeholder replacement, the
    // stored version/row, the context entry and the reaction/`#N` target.
    const response: AIResponse = {
        text: '',
        thinkingText: '',
        images: [imageBytes],
        groundingData: [],
    };
    const sent = await to(sendFinalResponse(chatContext, response));
    if (isErr(sent)) {
        console.error('[picgrok] Failed to send response:', sent[0]);
    }
};

/**
 * Check if message is a /picgrok command and extract its prompt. No reference
 * images: the xAI images endpoint takes a prompt only, as before the refactor.
 */
export const checkPicgrokCommand = async (
    ctx: Context
): Promise<[mention?: boolean, PicgrokCommandData?]> => {
    if (!ctx.message || !ctx.chat) return [undefined];

    // Get text from message or caption
    const text =
        ctx.message.text ||
        ('caption' in ctx.message ? ctx.message.caption : undefined);
    if (!text) return [undefined];

    const commandRegex = /^\/picgrok(@\S+)?\s*([\s\S]*)?$/;
    const matchResult = text.match(commandRegex);
    if (!matchResult) return [undefined];

    const prompt = matchResult[2]?.trim() || '';

    if (!prompt) {
        await sendBotNotice(ctx, '请输入图片描述');
        return [false];
    }

    return [true, { prompt }];
};

/**
 * Handle /picgrok. `access` is the trigger user's tier the caller already
 * resolved (the command branch gated on it); it rides into the attempt so the
 * metrics row knows whether the spend was a trial user's.
 */
export const handlePicgrokCommand = async (
    ctx: Context,
    commandData: PicgrokCommandData,
    access: AccessTier | null = null,
    dependencies: PicgrokGenerationDependencies = {}
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    console.log('[picgrok] Processing command:', { prompt: commandData.prompt });

    const chatContext = await createChatContext(ctx, {
        model: GROK_IMAGE_MODEL,
        commandType: 'picgrok',
        ...(access === null ? {} : { accessTier: access }),
    });
    if (!chatContext) {
        console.error('[picgrok] Failed to create chat context');
        // No placeholder to turn into the terminal state: leave a readable notice
        await sendBotNotice(ctx, '生成图片失败：无法开始这次生成，请重试。', {
            reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
    }

    await runPicgrokGeneration(chatContext, commandData.prompt, dependencies);
};
