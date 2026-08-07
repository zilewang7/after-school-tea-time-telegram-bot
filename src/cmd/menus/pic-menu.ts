/**
 * Buttons on generated pictures: ⏹ 取消 while a job runs, 🎲 重掷 once it's done.
 *
 * Both are looked up in the in-memory job store, so after a restart they answer
 * "任务已过期" instead of doing something surprising.
 */
import type { Bot } from 'grammy';
import { match } from 'ts-pattern';
import { to } from '../../shared/result.js';
import { parsePicCallback, PIC_CALLBACK_PREFIX } from '../../reply/commands/pic-buttons.js';
import { cancelJob, recallJob } from '../../reply/commands/pic-job-store.js';
import { runGeneration } from '../../reply/commands/pic-generation-runner.js';
import type { Context } from 'grammy';

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

    // The old picture keeps its caption but loses the button: one 🎲 per result
    await to(ctx.editMessageReplyMarkup({ reply_markup: undefined }));

    const request = {
        ...job.request,
        options: { ...job.request.options, seed: Math.floor(Math.random() * 2 ** 31) },
    };

    await runGeneration({
        api: ctx.api,
        chatId: job.chatId,
        userMessageId: job.userMessageId,
        request,
        spoiler: job.spoiler,
        workflowName: job.request.workflow,
    });
};

export const registerPicCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith(PIC_CALLBACK_PREFIX)) return next();

        const callback = parsePicCallback(data);
        if (!callback) {
            await ctx.answerCallbackQuery();
            return;
        }

        const [error] = await to(
            match(callback.action)
                .with('cancel', () => handleCancel(ctx, callback.jobId))
                .with('reroll', () => handleReroll(ctx, callback.jobId))
                .exhaustive()
        );
        if (error) {
            console.error('[pic-menu] callback failed:', error);
        }
    });
};
