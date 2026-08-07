/**
 * Submit → poll → deliver, for one generation job.
 *
 * Kept apart from the command layer because the 🎲 重掷 button re-enters here
 * with a request body it already has, skipping all the parsing.
 */
import { InputFile, InputMediaBuilder } from 'grammy';
import type { Api } from 'grammy';
import type { InputMediaPhoto } from 'grammy/types';
import { match } from 'ts-pattern';
import { to, isErr } from '../../shared/result.js';
import { saveMessage } from '../../db/index.js';
import {
    ComfyError,
    checkHealth,
    downloadImage,
    fetchGeneration,
    submitGeneration,
    type GenerationJob,
    type GenerationRequest,
} from '../../services/comfy-forward-service.js';
import { rememberJob, recallJob } from './pic-job-store.js';
import { buildCancelButton, buildRerollButton } from './pic-buttons.js';

/** Poll fast while the job is likely still queued, then back off */
const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 5000;
const FAST_WINDOW_MS = 30_000;

/** A home-connection blip shouldn't kill a job that is still running */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Progress text only changes on this grid, which keeps the edits sparse */
const HEARTBEAT_MS = 15_000;

const jobTimeoutMs = Number(process.env.COMFY_JOB_TIMEOUT_MS ?? 15 * 60 * 1000);

const botUserId = Number(process.env.BOT_USER_ID);
const botName = process.env.BOT_NAME ?? 'bot';

export interface GenerationRun {
    api: Api;
    chatId: number;
    /** The message the result replies to */
    userMessageId: number;
    request: GenerationRequest;
    spoiler: boolean;
    /** Human-readable workflow name, for the caption */
    workflowName: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const progressText = (status: GenerationJob['status'], elapsedMs: number): string => {
    const beats = Math.floor(elapsedMs / HEARTBEAT_MS) * (HEARTBEAT_MS / 1000);
    const waited = beats > 0 ? `（已 ${beats}s）` : '';
    return match(status)
        .with('queued', () => `🎨 已提交 · 排队中${waited}`)
        .with('running', () => `🎨 生成中${waited}`)
        .otherwise(() => '🎨 处理中');
};

/** `z-image-turbo · seed 12345` — enough to reproduce the picture by hand */
const captionOf = (run: GenerationRun): string => {
    const seed = run.request.options?.seed;
    return seed === undefined
        ? run.request.workflow
        : `${run.request.workflow} · seed ${String(seed)}`;
};

interface Placeholder {
    messageId: number;
}

/** Replace the placeholder with a final message (usually a failure) */
const settlePlaceholder = async (
    run: GenerationRun,
    placeholder: Placeholder,
    text: string
): Promise<void> => {
    const [editError] = await to(
        run.api.editMessageText(run.chatId, placeholder.messageId, text, {
            reply_markup: undefined,
        })
    );
    if (!editError) return;

    // The placeholder is gone (deleted by a user, or already replaced) — say it
    // as a fresh reply rather than swallowing the outcome
    await to(
        run.api.sendMessage(run.chatId, text, {
            reply_parameters: { message_id: run.userMessageId },
        })
    );
};

interface PollOutcome {
    job?: GenerationJob;
    /** Set when we stopped for a reason the user needs to hear */
    stopped?: string;
}

const pollUntilDone = async (
    run: GenerationRun,
    jobId: string,
    placeholder: Placeholder
): Promise<PollOutcome> => {
    const startedAt = Date.now();
    let lastText = '';
    let consecutiveFailures = 0;

    while (Date.now() - startedAt < jobTimeoutMs) {
        if (recallJob(jobId)?.cancelled) {
            return { stopped: '已取消等待。后端仍会把这张图跑完，只是不再等它了。' };
        }

        const elapsedMs = Date.now() - startedAt;
        await sleep(elapsedMs < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS);

        const [pollError, job] = await to(fetchGeneration(jobId));

        if (pollError) {
            const retryable = pollError instanceof ComfyError && pollError.retryable;
            consecutiveFailures += 1;
            if (!retryable || consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                return {
                    stopped:
                        pollError instanceof ComfyError
                            ? pollError.userMessage
                            : `查询任务状态失败：${pollError.message}`,
                };
            }
            continue;
        }
        consecutiveFailures = 0;

        if (job.status === 'succeeded' || job.status === 'failed') return { job };

        const text = progressText(job.status, Date.now() - startedAt);
        if (text !== lastText) {
            lastText = text;
            await to(
                run.api.editMessageText(run.chatId, placeholder.messageId, text, {
                    reply_markup: buildCancelButton(jobId),
                })
            );
        }
    }

    return {
        stopped: `等了 ${Math.round(jobTimeoutMs / 60000)} 分钟还没出图，任务可能还在跑，稍后可以再发一次。`,
    };
};

/** Store a picture the bot produced so it can be context — and a reference image */
const storeGeneratedImage = async (
    run: GenerationRun,
    messageId: number,
    image: Buffer
): Promise<void> => {
    const [error] = await to(
        saveMessage({
            chatId: run.chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botName,
            message: `[生成的图片] ${run.request.prompt}`.trim(),
            replyToId: run.userMessageId,
            fileBuffer: image,
            fileMime: 'image/png',
        })
    );
    if (error) {
        console.error(`[pic] failed to store generated image ${messageId}:`, error.message);
    }
};

const sendSingleImage = async (
    run: GenerationRun,
    jobId: string,
    image: Buffer
): Promise<void> => {
    const [sendError, sent] = await to(
        run.api.sendPhoto(run.chatId, new InputFile(image), {
            reply_parameters: { message_id: run.userMessageId },
            has_spoiler: run.spoiler,
            caption: captionOf(run),
            reply_markup: buildRerollButton(jobId),
        })
    );
    if (sendError) throw sendError;
    await storeGeneratedImage(run, sent.message_id, image);
};

/**
 * A batch goes out as an album. Albums cannot carry an inline keyboard, so a
 * batch has no 🎲 button — which is fine, since asking for `-n=4` is already
 * asking for variations.
 */
const sendImageBatch = async (run: GenerationRun, images: Buffer[]): Promise<void> => {
    const media: InputMediaPhoto[] = images.map((image, index) =>
        InputMediaBuilder.photo(new InputFile(image), {
            has_spoiler: run.spoiler,
            caption: index === 0 ? captionOf(run) : undefined,
        })
    );

    const [sendError, sent] = await to(
        run.api.sendMediaGroup(run.chatId, media, {
            reply_parameters: { message_id: run.userMessageId },
        })
    );
    if (sendError) throw sendError;

    for (const [index, message] of sent.entries()) {
        const image = images[index];
        if (image) await storeGeneratedImage(run, message.message_id, image);
    }
};

const deliver = async (
    run: GenerationRun,
    jobId: string,
    job: GenerationJob,
    placeholder: Placeholder
): Promise<void> => {
    if (job.images.length === 0) {
        await settlePlaceholder(run, placeholder, '生成成功了，但服务端没有返回图片');
        return;
    }

    const ordered = [...job.images].sort((a, b) => a.index - b.index);

    // Worth saying out loud: the box uploads at ~66 KB/s, so fetching a
    // finished picture is a visible wait, not a formality
    await to(
        run.api.editMessageText(
            run.chatId,
            placeholder.messageId,
            ordered.length === 1 ? '🎨 生成好了 · 下载中…' : `🎨 生成好了 · 下载 ${ordered.length} 张图中…`,
            { reply_markup: undefined }
        )
    );

    const downloaded: Buffer[] = [];
    for (const image of ordered) {
        const [downloadError, bytes] = await to(downloadImage(jobId, image.index));
        if (downloadError) {
            const reason =
                downloadError instanceof ComfyError
                    ? downloadError.userMessage
                    : downloadError.message;
            await settlePlaceholder(run, placeholder, `下载生成的图片失败：${reason}`);
            return;
        }
        downloaded.push(bytes);
    }

    const [sendError] = await to(
        downloaded.length === 1
            ? sendSingleImage(run, jobId, downloaded[0]!)
            : sendImageBatch(run, downloaded)
    );
    if (sendError) {
        await settlePlaceholder(run, placeholder, `图片发送失败：${sendError.message}`);
        return;
    }

    await to(run.api.deleteMessage(run.chatId, placeholder.messageId));
};

/**
 * Run one generation end to end. Never throws: every failure ends up in the
 * placeholder message.
 */
export const runGeneration = async (run: GenerationRun): Promise<void> => {
    const health = await checkHealth();
    if (!health.ok) {
        await to(
            run.api.sendMessage(run.chatId, health.reason ?? '生图服务未启动', {
                reply_parameters: { message_id: run.userMessageId },
            })
        );
        return;
    }

    const queued = health.queue?.pending ?? 0;
    const opening = queued > 0 ? `🎨 已提交 · 前面还有 ${queued} 个任务` : '🎨 已提交 · 排队中';

    const placeholderResult = await to(
        run.api.sendMessage(run.chatId, opening, {
            reply_parameters: { message_id: run.userMessageId },
        })
    );
    if (isErr(placeholderResult)) {
        console.error('[pic] could not post the placeholder:', placeholderResult[0].message);
        return;
    }
    const placeholder: Placeholder = { messageId: placeholderResult[1].message_id };

    const submitResult = await to(submitGeneration(run.request));
    if (isErr(submitResult)) {
        const error = submitResult[0];
        await settlePlaceholder(
            run,
            placeholder,
            error instanceof ComfyError ? error.userMessage : `提交任务失败：${error.message}`
        );
        return;
    }
    const jobId = submitResult[1];

    rememberJob(jobId, {
        chatId: run.chatId,
        userMessageId: run.userMessageId,
        request: run.request,
        spoiler: run.spoiler,
        cancelled: false,
    });

    await to(
        run.api.editMessageReplyMarkup(run.chatId, placeholder.messageId, {
            reply_markup: buildCancelButton(jobId),
        })
    );

    const outcome = await pollUntilDone(run, jobId, placeholder);

    if (outcome.stopped !== undefined) {
        await settlePlaceholder(run, placeholder, outcome.stopped);
        return;
    }
    if (!outcome.job) return;

    if (outcome.job.status === 'failed') {
        await settlePlaceholder(run, placeholder, `生成失败：${outcome.job.error ?? '服务端没有说明原因'}`);
        return;
    }

    await deliver(run, jobId, outcome.job, placeholder);
};
