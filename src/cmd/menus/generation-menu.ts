/**
 * Buttons on generated pictures and videos: ⏹ 取消 while a job runs,
 * 🎲 重掷 once it's done, 🔄 重试 on anything that failed, ✍️ 重写分镜 on a
 * storyboard.
 *
 * All four are looked up in in-memory stores, so after a restart they answer
 * "任务已过期" instead of doing something surprising.
 */
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import { to } from '../../shared/result.js';
import {
    parseGenerationCallback,
    GENERATION_CALLBACK_PREFIX,
} from '../../reply/commands/generation-buttons.js';
import { cancelJob, recallJob } from '../../reply/commands/generation-job-store.js';
import { recallAction } from '../../reply/commands/generation-actions.js';
import { runGeneration } from '../../reply/commands/generation-runner.js';

const EXPIRED = '这个任务已经过期了（bot 重启过），请重新发一次命令';

const handleCancel = async (ctx: Context, jobId: string): Promise<void> => {
    const cancelled = cancelJob(jobId);
    await ctx.answerCallbackQuery({ text: cancelled ? '已取消等待' : EXPIRED });
};

/**
 * Same request, new seed. The result replies to the original user message, so a
 * reroll chain stays attached to what was asked for rather than to the picture.
 */
const handleReroll = async (ctx: Context, jobId: string): Promise<void> => {
    const job = recallJob(jobId);
    if (!job) {
        await ctx.answerCallbackQuery({ text: EXPIRED });
        return;
    }

    await ctx.answerCallbackQuery({ text: '重掷中…' });

    // The old result keeps its caption but loses the button: one 🎲 per result
    await to(ctx.editMessageReplyMarkup({ reply_markup: undefined }));

    const request = {
        ...job.request,
        options: { ...job.request.options, seed: Math.floor(Math.random() * 2 ** 31) },
    };

    await runGeneration({
        api: ctx.api,
        chatId: job.chatId,
        userMessageId: job.userMessageId,
        kind: job.kind,
        request,
        spoiler: job.spoiler,
        workflowName: job.workflowName,
    });
};

/**
 * 🔄 and ✍️ are both "run this closure again", differing only in what the
 * closure was built to do and what the toast says while it runs.
 */
const handleStoredAction = async (
    ctx: Context,
    actionId: string,
    toast: string
): Promise<void> => {
    const action = recallAction(actionId);
    if (!action) {
        await ctx.answerCallbackQuery({ text: EXPIRED });
        return;
    }

    await ctx.answerCallbackQuery({ text: toast });

    // Drop the button first: a second tap would start a second job, and the
    // whole point is that the first one is already under way again
    await to(ctx.editMessageReplyMarkup({ reply_markup: undefined }));

    await action();
};

export const registerGenerationCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith(GENERATION_CALLBACK_PREFIX)) return next();

        const callback = parseGenerationCallback(data);
        if (!callback) {
            await ctx.answerCallbackQuery();
            return;
        }

        const [error] = await to(
            match(callback.action)
                .with('cancel', () => handleCancel(ctx, callback.id))
                .with('reroll', () => handleReroll(ctx, callback.id))
                .with('retry', () => handleStoredAction(ctx, callback.id, '重试中…'))
                .with('rewrite', () => handleStoredAction(ctx, callback.id, '重写分镜中…'))
                .exhaustive()
        );
        if (error) {
            console.error('[generation-menu] callback failed:', error);
        }
    });
};
