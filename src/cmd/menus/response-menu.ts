/**
 * Response menu for bot messages
 * Handles stop, retry, and version switching
 *
 * Uses raw callback_query handling instead of Grammy Menu
 * because Menu's callback_data format is too complex for manual InlineKeyboard
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import { to } from '../../shared/result';
import {
    findBotResponseByMessageId,
    ButtonState,
} from '../../db';
import {
    stopResponse,
    switchVersion,
} from '../../services';

// Callback data prefix for our buttons
const CALLBACK_PREFIX = 'resp:';

// Store retry handler reference
let retryHandler: ((ctx: Context, firstMessageId: number) => Promise<void>) | null = null;

/**
 * Set the retry handler function
 */
export const setRetryHandler = (
    handler: (ctx: Context, firstMessageId: number) => Promise<void>
): void => {
    retryHandler = handler;
};

/**
 * Register callback query handlers on bot
 * Must be called during bot initialization
 */
export const registerResponseCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;

        // Only handle our callbacks
        if (!data.startsWith(CALLBACK_PREFIX)) {
            return next();
        }

        const action = data.slice(CALLBACK_PREFIX.length);

        await match(action)
            .with('stop', () => handleStop(ctx))
            .with('retry', () => handleRetry(ctx))
            .with('prev', () => handlePrev(ctx))
            .with('next', () => handleNext(ctx))
            .otherwise(() => ctx.answerCallbackQuery({ text: '未知操作' }));
    });
};

/**
 * Stop button handler - async execution
 */
const handleStop = async (ctx: Context): Promise<void> => {
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
        await ctx.answerCallbackQuery({ text: '消息无效' });
        return;
    }

    const [err, response] = await to(findBotResponseByMessageId(msg.chat.id, msg.message_id));
    if (err || !response) {
        await ctx.answerCallbackQuery({ text: '找不到消息记录' });
        return;
    }

    // Answer callback immediately
    await ctx.answerCallbackQuery({ text: '停止中...' });

    // Execute stop asynchronously
    setImmediate(async () => {
        const [stopErr] = await to(stopResponse(msg.chat.id, response.messageId));
        if (stopErr) {
            console.error('[response-menu] Stop failed:', stopErr);
        }
    });
};

/**
 * Retry button handler - async execution
 */
const handleRetry = async (ctx: Context): Promise<void> => {
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
        await ctx.answerCallbackQuery({ text: '消息无效' });
        return;
    }

    const [err, response] = await to(findBotResponseByMessageId(msg.chat.id, msg.message_id));
    if (err || !response) {
        await ctx.answerCallbackQuery({ text: '找不到消息记录' });
        return;
    }

    if (!retryHandler) {
        console.error('[response-menu] Retry handler not set');
        await ctx.answerCallbackQuery({ text: '重试功能未配置' });
        return;
    }

    // Answer callback immediately
    await ctx.answerCallbackQuery({ text: '重试中...' });

    // Execute retry asynchronously
    setImmediate(async () => {
        const [retryErr] = await to(retryHandler!(ctx, response.messageId));
        if (retryErr) {
            console.error('[response-menu] Retry failed:', retryErr);
        }
    });
};

/**
 * Previous version button handler - async execution
 */
const handlePrev = async (ctx: Context): Promise<void> => {
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
        await ctx.answerCallbackQuery({ text: '消息无效' });
        return;
    }

    const [err, response] = await to(findBotResponseByMessageId(msg.chat.id, msg.message_id));
    if (err || !response) {
        await ctx.answerCallbackQuery({ text: '找不到消息记录' });
        return;
    }

    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;

    // Answer callback immediately with version info
    await ctx.answerCallbackQuery({ text: `切换到版本 ${currentIndex}/${versions.length}` });

    // Execute switch asynchronously
    setImmediate(async () => {
        const [switchErr] = await to(switchVersion(ctx, response.messageId, 'prev'));
        if (switchErr) {
            console.error('[response-menu] Version switch failed:', switchErr);
        }
    });
};

/**
 * Next version button handler - async execution
 */
const handleNext = async (ctx: Context): Promise<void> => {
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
        await ctx.answerCallbackQuery({ text: '消息无效' });
        return;
    }

    const [err, response] = await to(findBotResponseByMessageId(msg.chat.id, msg.message_id));
    if (err || !response) {
        await ctx.answerCallbackQuery({ text: '找不到消息记录' });
        return;
    }

    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;

    // Answer callback immediately with version info
    await ctx.answerCallbackQuery({ text: `切换到版本 ${currentIndex + 2}/${versions.length}` });

    // Execute switch asynchronously
    setImmediate(async () => {
        const [switchErr] = await to(switchVersion(ctx, response.messageId, 'next'));
        if (switchErr) {
            console.error('[response-menu] Version switch failed:', switchErr);
        }
    });
};

/**
 * Build InlineKeyboard based on button state
 * Uses simple callback_data format: resp:action
 */
export const buildResponseButtons = (
    buttonState: ButtonState,
    currentVersionIndex: number = 0,
    totalVersions: number = 1
): InlineKeyboard | undefined => {
    return match(buttonState)
        .with(ButtonState.PROCESSING, () =>
            new InlineKeyboard().text('停止', `${CALLBACK_PREFIX}stop`)
        )
        .with(ButtonState.RETRY_ONLY, () =>
            new InlineKeyboard().text('重试', `${CALLBACK_PREFIX}retry`)
        )
        .with(ButtonState.HAS_VERSIONS, () => {
            const kb = new InlineKeyboard();

            if (currentVersionIndex > 0) {
                kb.text('<', `${CALLBACK_PREFIX}prev`);
            }

            kb.text('重试', `${CALLBACK_PREFIX}retry`);

            if (currentVersionIndex < totalVersions - 1) {
                kb.text('>', `${CALLBACK_PREFIX}next`);
            }

            return kb;
        })
        .otherwise(() => undefined);
};
