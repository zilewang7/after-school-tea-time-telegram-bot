/**
 * Submit → poll → deliver, for one generation job — picture or video.
 *
 * Kept apart from the command layer because the 🎲 重掷 button re-enters here
 * with a request body it already has, skipping all the parsing.
 *
 * Pictures and videos differ only in the last step (what gets downloaded and
 * which send method carries it). Everything before that — health, placeholder,
 * submit, poll, heartbeat, cancel, failure reporting — is one code path, so
 * `kind` selects behaviour rather than there being two of these files.
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
    downloadResult,
    fetchGeneration,
    resultsOf,
    submitGeneration,
    type GenerationJob,
    type GenerationMediaKind,
    type GenerationRequest,
} from '../../services/comfy-forward-service.js';
import { rememberJob, recallJob } from './generation-job-store.js';
import { rememberAction, type GenerationActionFn } from './generation-actions.js';
import { buildCancelButton, buildRerollButton, buildRetryButton } from './generation-buttons.js';

/** Poll fast while the job is likely still queued, then back off */
const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 5000;
const FAST_WINDOW_MS = 30_000;

/** A home-connection blip shouldn't kill a job that is still running */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Progress text only changes on this grid, which keeps the edits sparse */
const HEARTBEAT_MS = 15_000;

const pictureJobTimeoutMs = Number(process.env.COMFY_JOB_TIMEOUT_MS ?? 15 * 60 * 1000);
/**
 * H3 needs 1-3 minutes per clip on that box and the GPU runs one job at a
 * time, so a couple of queued videos ahead of yours already blow the picture
 * budget. Waiting longer costs nothing but a poll every 5s.
 */
const videoJobTimeoutMs = Number(process.env.COMFY_VIDEO_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);

const botUserId = Number(process.env.BOT_USER_ID);
const botName = process.env.BOT_NAME ?? 'bot';

export interface GenerationRun {
    api: Api;
    chatId: number;
    /** The message the result replies to */
    userMessageId: number;
    /** Picture or video — decided by the workflow the command picked */
    kind: GenerationMediaKind;
    request: GenerationRequest;
    spoiler: boolean;
    /** Human-readable workflow name, for the caption */
    workflowName: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const iconOf = (kind: GenerationMediaKind): string => (kind === 'video' ? '🎬' : '🎨');

const jobTimeoutOf = (kind: GenerationMediaKind): number =>
    kind === 'video' ? videoJobTimeoutMs : pictureJobTimeoutMs;

const progressText = (
    kind: GenerationMediaKind,
    status: GenerationJob['status'],
    elapsedMs: number
): string => {
    const beats = Math.floor(elapsedMs / HEARTBEAT_MS) * (HEARTBEAT_MS / 1000);
    const waited = beats > 0 ? `（已 ${beats}s）` : '';
    const icon = iconOf(kind);
    return match(status)
        .with('queued', () => `${icon} 已提交 · 排队中${waited}`)
        .with('running', () => `${icon} 生成中${waited}`)
        .otherwise(() => `${icon} 处理中`);
};

/**
 * `z-image-turbo · seed 12345` — enough to reproduce the result by hand. A
 * video adds the two knobs that decide how long it took and how it is framed.
 */
const captionOf = (run: GenerationRun): string => {
    const options = run.request.options ?? {};
    const parts = [run.request.workflow];
    if (options.seed !== undefined) parts.push(`seed ${String(options.seed)}`);
    if (run.kind === 'video') {
        if (options.duration_seconds !== undefined) parts.push(`${String(options.duration_seconds)}s`);
        if (options.aspect_ratio !== undefined) parts.push(String(options.aspect_ratio));
    }
    return parts.join(' · ');
};

interface Placeholder {
    messageId: number;
}

/**
 * Replace the placeholder with a final message (usually a failure).
 *
 * `retry` is what 🔄 will do. Nearly every failure here is worth one tap —
 * dropped connections to that box are routine, and retyping a prompt with
 * half a dozen flags because the tunnel blinked is miserable.
 */
const settlePlaceholder = async (
    run: GenerationRun,
    placeholder: Placeholder,
    text: string,
    retry?: GenerationActionFn
): Promise<void> => {
    const markup = retry ? buildRetryButton(rememberAction(retry)) : undefined;

    const [editError] = await to(
        run.api.editMessageText(run.chatId, placeholder.messageId, text, {
            reply_markup: markup,
        })
    );
    if (!editError) return;

    // The placeholder is gone (deleted by a user, or already replaced) — say it
    // as a fresh reply rather than swallowing the outcome
    await to(
        run.api.sendMessage(run.chatId, text, {
            reply_parameters: { message_id: run.userMessageId },
            reply_markup: markup,
        })
    );
};

interface PollOutcome {
    job?: GenerationJob;
    /** Set when we stopped for a reason the user needs to hear */
    stopped?: string;
    /** The user pressed ⏹ — a stop, not a failure */
    cancelled?: boolean;
}

const pollUntilDone = async (
    run: GenerationRun,
    jobId: string,
    placeholder: Placeholder
): Promise<PollOutcome> => {
    const startedAt = Date.now();
    const timeoutMs = jobTimeoutOf(run.kind);
    let lastText = '';
    let consecutiveFailures = 0;

    while (Date.now() - startedAt < timeoutMs) {
        if (recallJob(jobId)?.cancelled) {
            return {
                stopped: '已取消等待。后端仍会把它跑完，只是不再等它了。',
                cancelled: true,
            };
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

        const text = progressText(run.kind, job.status, Date.now() - startedAt);
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
        stopped: `等了 ${Math.round(timeoutMs / 60000)} 分钟还没出结果，任务可能还在跑，稍后可以再发一次。`,
    };
};

/** Store what the bot produced so it can be context — and a reference later */
const storeGeneratedMedia = async (
    run: GenerationRun,
    messageId: number,
    bytes: Buffer
): Promise<void> => {
    const label = run.kind === 'video' ? '[生成的视频]' : '[生成的图片]';
    const [error] = await to(
        saveMessage({
            chatId: run.chatId,
            messageId,
            userId: botUserId,
            date: new Date(),
            userName: botName,
            message: `${label} ${run.request.prompt}`.trim(),
            replyToId: run.userMessageId,
            fileBuffer: bytes,
            fileMime: run.kind === 'video' ? 'video/mp4' : 'image/png',
        })
    );
    if (error) {
        console.error(`[gen] failed to store generated media ${messageId}:`, error.message);
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
    await storeGeneratedMedia(run, sent.message_id, image);
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
        if (image) await storeGeneratedMedia(run, message.message_id, image);
    }
};

/**
 * H3 returns exactly one clip today, but the envelope is an array, so send
 * them one by one rather than silently dropping anything past the first. Only
 * the first carries 🎲 — one reroll per job, same as a picture.
 */
const sendVideos = async (run: GenerationRun, jobId: string, videos: Buffer[]): Promise<void> => {
    for (const [index, video] of videos.entries()) {
        const [sendError, sent] = await to(
            run.api.sendVideo(run.chatId, new InputFile(video, `generated-${index}.mp4`), {
                reply_parameters: { message_id: run.userMessageId },
                has_spoiler: run.spoiler,
                caption: index === 0 ? captionOf(run) : undefined,
                supports_streaming: true,
                reply_markup: index === 0 ? buildRerollButton(jobId) : undefined,
            })
        );
        if (sendError) throw sendError;
        await storeGeneratedMedia(run, sent.message_id, video);
    }
};

const deliver = async (
    run: GenerationRun,
    jobId: string,
    job: GenerationJob,
    placeholder: Placeholder
): Promise<void> => {
    const results = resultsOf(job, run.kind);
    if (results.length === 0) {
        await settlePlaceholder(run, placeholder, '生成成功了，但服务端没有返回结果', () =>
            runGeneration(run)
        );
        return;
    }

    const ordered = [...results].sort((a, b) => a.index - b.index);
    const noun = run.kind === 'video' ? '视频' : '图';

    // Worth saying out loud: the box uploads at ~66 KB/s, so fetching a
    // finished result is a visible wait, not a formality
    await to(
        run.api.editMessageText(
            run.chatId,
            placeholder.messageId,
            ordered.length === 1
                ? `${iconOf(run.kind)} 生成好了 · 下载中…`
                : `${iconOf(run.kind)} 生成好了 · 下载 ${ordered.length} 个${noun}中…`,
            { reply_markup: undefined }
        )
    );

    // Retrying delivery re-downloads rather than re-generating: the result is
    // already sitting on the far side, and making the GPU redo three minutes of
    // work because the transfer stalled would be daft. If the job has aged out
    // of the server by then, the 404 says so in Chinese on its own.
    const retryDelivery = (): Promise<void> => deliver(run, jobId, job, placeholder);

    const downloaded: Buffer[] = [];
    for (const result of ordered) {
        const [downloadError, bytes] = await to(downloadResult(run.kind, jobId, result.index));
        if (downloadError) {
            const reason =
                downloadError instanceof ComfyError
                    ? downloadError.userMessage
                    : downloadError.message;
            await settlePlaceholder(
                run,
                placeholder,
                `下载生成的${noun}失败：${reason}`,
                retryDelivery
            );
            return;
        }
        downloaded.push(bytes);
    }

    const [sendError] = await to(
        match(run.kind)
            .with('video', () => sendVideos(run, jobId, downloaded))
            .with('image', () =>
                downloaded.length === 1
                    ? sendSingleImage(run, jobId, downloaded[0]!)
                    : sendImageBatch(run, downloaded)
            )
            .exhaustive()
    );
    if (sendError) {
        await settlePlaceholder(run, placeholder, `发送失败：${sendError.message}`, retryDelivery);
        return;
    }

    await to(run.api.deleteMessage(run.chatId, placeholder.messageId));
};

/**
 * Run one generation end to end. Never throws: every failure ends up in the
 * placeholder message.
 */
export const runGeneration = async (run: GenerationRun): Promise<void> => {
    const retryEverything = (): Promise<void> => runGeneration(run);

    const health = await checkHealth();
    if (!health.ok) {
        // The most common single failure: the box was simply off. 🔄 turns
        // "go switch it on and retype your command" into "go switch it on".
        await to(
            run.api.sendMessage(run.chatId, health.reason ?? '生成服务未启动', {
                reply_parameters: { message_id: run.userMessageId },
                reply_markup: buildRetryButton(rememberAction(retryEverything)),
            })
        );
        return;
    }

    const icon = iconOf(run.kind);
    const queued = health.queue?.pending ?? 0;
    const opening = queued > 0 ? `${icon} 已提交 · 前面还有 ${queued} 个任务` : `${icon} 已提交 · 排队中`;

    const placeholderResult = await to(
        run.api.sendMessage(run.chatId, opening, {
            reply_parameters: { message_id: run.userMessageId },
        })
    );
    if (isErr(placeholderResult)) {
        console.error('[gen] could not post the placeholder:', placeholderResult[0].message);
        return;
    }
    const placeholder: Placeholder = { messageId: placeholderResult[1].message_id };

    const submitResult = await to(submitGeneration(run.request));
    if (isErr(submitResult)) {
        const error = submitResult[0];
        await settlePlaceholder(
            run,
            placeholder,
            error instanceof ComfyError ? error.userMessage : `提交任务失败：${error.message}`,
            retryEverything
        );
        return;
    }
    const jobId = submitResult[1];

    rememberJob(jobId, {
        kind: run.kind,
        chatId: run.chatId,
        userMessageId: run.userMessageId,
        request: run.request,
        spoiler: run.spoiler,
        workflowName: run.workflowName,
        cancelled: false,
    });

    await to(
        run.api.editMessageReplyMarkup(run.chatId, placeholder.messageId, {
            reply_markup: buildCancelButton(jobId),
        })
    );

    const outcome = await pollUntilDone(run, jobId, placeholder);

    if (outcome.stopped !== undefined) {
        // Cancelling was deliberate; offering to undo it with one tap would
        // just be a way to start a job by accident
        await settlePlaceholder(
            run,
            placeholder,
            outcome.stopped,
            outcome.cancelled ? undefined : retryEverything
        );
        return;
    }
    if (!outcome.job) return;

    if (outcome.job.status === 'failed') {
        await settlePlaceholder(
            run,
            placeholder,
            `生成失败：${outcome.job.error ?? '服务端没有说明原因'}`,
            retryEverything
        );
        return;
    }

    await deliver(run, jobId, outcome.job, placeholder);
};
