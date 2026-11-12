/**
 * Response menu for bot messages
 * Handles stop, retry, continue, and version switching
 *
 * Uses raw callback_query handling instead of Grammy Menu
 * because Menu's callback_data format is too complex for manual InlineKeyboard
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import { to } from '../../shared/result.js';
import {
    findBotResponseByMessageId,
    ButtonState,
    type BotResponse,
} from '../../db/index.js';
import {
    stopResponse,
    switchVersion,
    refreshToFinalState,
} from '../../services/index.js';
import { isCallbackChatPaused, PAUSED_CALLBACK_NOTICE } from '../../reply/chat-pause.js';
import {
    isReplyRerunClaimed,
    releaseReplyRerun,
    showsResumableVersion,
    tryClaimReplyRerun,
} from '../../state.js';

// Callback data prefix for our buttons
const CALLBACK_PREFIX = 'resp:';

/** A second retry or continue click while the first one is still being handled */
const RERUN_CLAIMED_NOTICE = '正在处理';
/** A click between a retry's claim and its PROCESSING write */
const RERUN_STARTING_NOTICE = '正在启动，请稍后再点';
/** A button whose action this version of the bot does not know */
const UNKNOWN_ACTION_NOTICE = '按钮已失效，已刷新';
/** The checks of a continue click failed unexpectedly; nothing was taken */
const CONTINUE_CHECK_FAILED_NOTICE = '暂时无法继续，请稍后再试';

/**
 * The toast for a button pressed while a retry or continue of the reply holds
 * its claim. Its buttons are left alone: the run is about to change them, and
 * a refresh from the state read before would put the old ones back.
 */
const rerunNoticeOf = (response: BotResponse): string =>
    response.buttonState === ButtonState.PROCESSING ? '还在生成中' : RERUN_STARTING_NOTICE;

/** Regenerates a reply; resolves once the new version has ended */
type RetryHandler = (ctx: Context, firstMessageId: number) => Promise<void>;

// Store retry handler reference
let retryHandler: RetryHandler | null = null;

/**
 * Set the retry handler function
 */
export const setRetryHandler = (handler: RetryHandler): void => {
    retryHandler = handler;
};

/**
 * How a started continue ended: the resumed reply ran (whatever its own
 * outcome), or the checkpoint was gone by the time it was taken
 */
export type ContinueStartOutcome = 'resumed' | 'gone';

/**
 * What a "继续" click's checks found, made while the kept checkpoint is only
 * looked at (design 2026-1112-1123 §6.4)
 */
export type ContinueVerdict =
    /** Everything holds: `start` takes the checkpoint at once and resolves when the resumed reply has ended */
    | { readonly kind: 'ready'; readonly start: () => Promise<ContinueStartOutcome> }
    /** The checkpoint is gone (the checks dropped what was left): the buttons lose "继续" */
    | { readonly kind: 'gone'; readonly notice: string }
    /** Not now: only the notice; the checkpoint, its mark and the buttons stay for a later click */
    | { readonly kind: 'keep'; readonly notice: string };

/**
 * Checks a continue click on a reply that is not generating. It lives in the
 * reply layer, which imports this module, so it is handed in like the retry
 * handler.
 */
type ContinueHandler = (ctx: Context, response: BotResponse) => Promise<ContinueVerdict>;

let continueHandler: ContinueHandler | null = null;

export const setContinueHandler = (handler: ContinueHandler): void => {
    continueHandler = handler;
};

/**
 * Refresh the buttons on a message to match the current BotResponse state.
 * Used as a self-correction mechanism when a callback finds stale buttons.
 */
const refreshButtonsToCurrent = async (
    ctx: Context,
    response: BotResponse,
    messageId: number
): Promise<void> => {
    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;
    const buttonState = response.buttonState;

    const buttons = buildResponseButtons(buttonState, currentIndex, versions.length, {
        resumable: showsResumableVersion(response.chatId, response.messageId, versions, currentIndex),
    });
    const [err] = await to(
        ctx.api.editMessageReplyMarkup(ctx.callbackQuery!.message!.chat.id, messageId, {
            reply_markup: buttons,
        })
    );
    if (err) {
        console.warn('[response-menu] Failed to refresh buttons:', err.message);
    }
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
            .with('continue', () => handleContinue(ctx))
            .with('prev', () => handlePrev(ctx))
            .with('next', () => handleNext(ctx))
            .otherwise(() => handleUnknownAction(ctx));
    });
};

/**
 * A `resp:` action this version does not know (a button from a newer or a
 * rolled-back version): the buttons are refreshed to the reply's current
 * state, so the click is not a dead end.
 */
const handleUnknownAction = async (ctx: Context): Promise<void> => {
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
        await ctx.answerCallbackQuery({ text: '未知操作' });
        return;
    }

    const [err, response] = await to(findBotResponseByMessageId(msg.chat.id, msg.message_id));
    if (err || !response) {
        await ctx.answerCallbackQuery({ text: '未知操作' });
        return;
    }

    if (isReplyRerunClaimed(msg.chat.id, response.messageId)) {
        await ctx.answerCallbackQuery({ text: rerunNoticeOf(response) });
        return;
    }

    await ctx.answerCallbackQuery({ text: UNKNOWN_ACTION_NOTICE });
    await refreshButtonsToCurrent(ctx, response, msg.message_id);
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

    // A retry or continue was claimed but has not written PROCESSING yet: there
    // is nothing to stop so far, and the refresh below would put the old
    // version back over the reply that is starting
    if (
        response.buttonState !== ButtonState.PROCESSING &&
        isReplyRerunClaimed(msg.chat.id, response.messageId)
    ) {
        await ctx.answerCallbackQuery({ text: RERUN_STARTING_NOTICE });
        return;
    }

    // Self-correction: if the response is no longer in PROCESSING state, the
    // stream already ended — the message may be stuck in an intermediate state
    // (e.g. the final edit was lost to a 429). Refresh text AND buttons to the
    // final state saved in the database.
    if (response.buttonState !== ButtonState.PROCESSING) {
        await ctx.answerCallbackQuery({ text: '已结束，刷新到最新状态' });
        setImmediate(async () => {
            const [refreshErr, refreshed] = await to(
                refreshToFinalState(ctx.api, msg.chat.id, response.messageId)
            );
            if (refreshErr || !refreshed) {
                console.error('[response-menu] Refresh to final state failed:', refreshErr);
                // Fall back to at least fixing the buttons
                await refreshButtonsToCurrent(ctx, response, msg.message_id);
            }
        });
        return;
    }

    // Answer callback immediately
    await ctx.answerCallbackQuery({ text: '停止中...' });

    // Execute stop asynchronously
    setImmediate(async () => {
        const [stopErr, stopped] = await to(stopResponse(msg.chat.id, response.messageId));
        if (stopErr) {
            console.error('[response-menu] Stop failed:', stopErr);
            return;
        }
        // A claimed run that already ended owns the stored state; only a
        // reply nobody runs any more is made retryable here
        if (!stopped && !isReplyRerunClaimed(msg.chat.id, response.messageId)) {
            // PROCESSING in DB but no active session (e.g. bot restarted
            // mid-stream): mark retryable and refresh the buttons
            response.buttonState = ButtonState.RETRY_ONLY;
            await to(response.save());
            await refreshButtonsToCurrent(ctx, response, msg.message_id);
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

    // Taken right after the lookup, with no await in between: of two fast
    // clicks only one starts a retry. The loser leaves the buttons alone, the
    // winner is about to change them.
    const chatId = msg.chat.id;
    const firstMessageId = response.messageId;
    if (!tryClaimReplyRerun(chatId, firstMessageId)) {
        await ctx.answerCallbackQuery({ text: RERUN_CLAIMED_NOTICE });
        return;
    }

    // Released below on every way out, unless the detached retry took it over
    let retryDetached = false;
    try {
        // Self-correction: if still processing, refuse retry and refresh buttons
        if (response.buttonState === ButtonState.PROCESSING) {
            await ctx.answerCallbackQuery({ text: '还在生成中' });
            await refreshButtonsToCurrent(ctx, response, msg.message_id);
            return;
        }

        // A paused chat generates nothing; switching versions stays available
        if (isCallbackChatPaused(ctx)) {
            await ctx.answerCallbackQuery({ text: PAUSED_CALLBACK_NOTICE });
            return;
        }

        const handler = retryHandler;
        if (!handler) {
            console.error('[response-menu] Retry handler not set');
            await ctx.answerCallbackQuery({ text: '重试功能未配置' });
            return;
        }

        // Answer callback immediately
        await ctx.answerCallbackQuery({ text: '重试中...' });

        // Execute retry asynchronously; it holds the claim until it has ended
        setImmediate(() => {
            void runRetryHoldingClaim(ctx, handler, chatId, firstMessageId);
        });
        retryDetached = true;
    } finally {
        if (!retryDetached) releaseReplyRerun(chatId, firstMessageId);
    }
};

/** Run a claimed retry to its end, then give the claim back whatever happened */
const runRetryHoldingClaim = async (
    ctx: Context,
    handler: RetryHandler,
    chatId: number,
    firstMessageId: number
): Promise<void> => {
    try {
        const [retryErr] = await to(handler(ctx, firstMessageId));
        if (retryErr) {
            console.error('[response-menu] Retry failed:', retryErr);
        }
    } finally {
        releaseReplyRerun(chatId, firstMessageId);
    }
};

/**
 * Continue button handler (design 2026-1112-1123 §6.4, §7.3). The order:
 * look the reply up; claim it with no await in between; check while only
 * looking at the kept checkpoint; then either answer why not and give the
 * claim back, or answer, take the checkpoint and hold the claim until the
 * resumed reply has ended.
 */
const handleContinue = async (ctx: Context): Promise<void> => {
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

    // As for retry: of two fast clicks only one gets past here, and the loser
    // leaves the buttons to the winner
    const chatId = msg.chat.id;
    const firstMessageId = response.messageId;
    if (!tryClaimReplyRerun(chatId, firstMessageId)) {
        await ctx.answerCallbackQuery({ text: RERUN_CLAIMED_NOTICE });
        return;
    }

    // Released below on every way out, unless the resumed reply took it over
    let continueDetached = false;
    try {
        if (response.buttonState === ButtonState.PROCESSING) {
            await ctx.answerCallbackQuery({ text: '还在生成中' });
            await refreshButtonsToCurrent(ctx, response, msg.message_id);
            return;
        }

        const handler = continueHandler;
        if (!handler) {
            console.error('[response-menu] Continue handler not set');
            await ctx.answerCallbackQuery({ text: '继续功能未配置' });
            return;
        }

        const [checkErr, verdict] = await to(handler(ctx, response));
        if (checkErr) {
            // Nothing was taken: a later click can still continue
            console.error('[response-menu] Continue check failed:', checkErr);
            await ctx.answerCallbackQuery({ text: CONTINUE_CHECK_FAILED_NOTICE });
            return;
        }

        await match(verdict)
            .with({ kind: 'keep' }, async ({ notice }) => {
                await ctx.answerCallbackQuery({ text: notice });
            })
            .with({ kind: 'gone' }, async ({ notice }) => {
                await ctx.answerCallbackQuery({ text: notice });
                // The checks cleared the mark: the redraw leaves "继续" out
                await refreshButtonsToCurrent(ctx, response, msg.message_id);
            })
            .with({ kind: 'ready' }, async ({ start }) => {
                // A failed answer leaves the checkpoint where it is
                await ctx.answerCallbackQuery({ text: '继续中...' });
                // start() takes the checkpoint before it first waits; the
                // resumed reply runs on without holding up this update
                void runContinueHoldingClaim(ctx, start(), response, msg.message_id);
                continueDetached = true;
            })
            .exhaustive();
    } finally {
        if (!continueDetached) releaseReplyRerun(chatId, firstMessageId);
    }
};

/** Wait for a resumed reply to end, then give the claim back whatever happened */
const runContinueHoldingClaim = async (
    ctx: Context,
    running: Promise<ContinueStartOutcome>,
    response: BotResponse,
    messageId: number
): Promise<void> => {
    try {
        const [continueErr, outcome] = await to(running);
        if (continueErr) {
            console.error('[response-menu] Continue failed:', continueErr);
        } else if (outcome === 'gone') {
            // It expired between the checks and the take: as a gone click, but
            // the toast already went out, so only the buttons lose "继续"
            await refreshButtonsToCurrent(ctx, response, messageId);
        }
    } finally {
        releaseReplyRerun(response.chatId, response.messageId);
    }
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

    // A retry or continue is starting or running: switching now would edit
    // the messages it streams into
    if (isReplyRerunClaimed(msg.chat.id, response.messageId)) {
        await ctx.answerCallbackQuery({ text: rerunNoticeOf(response) });
        return;
    }

    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;

    // Self-correction: if can't go prev, refresh buttons
    if (currentIndex <= 0) {
        await ctx.answerCallbackQuery({ text: '已是第一个版本' });
        await refreshButtonsToCurrent(ctx, response, msg.message_id);
        return;
    }

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

    // Same as prev: never switch under a starting or running retry
    if (isReplyRerunClaimed(msg.chat.id, response.messageId)) {
        await ctx.answerCallbackQuery({ text: rerunNoticeOf(response) });
        return;
    }

    const versions = response.getVersions();
    const currentIndex = response.currentVersionIndex;

    // Self-correction: if can't go next, refresh buttons
    if (currentIndex >= versions.length - 1) {
        await ctx.answerCallbackQuery({ text: '已是最新版本' });
        await refreshButtonsToCurrent(ctx, response, msg.message_id);
        return;
    }

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

export interface ResponseButtonOptions {
    /**
     * The version on screen is a failed or stopped latest version whose
     * checkpoint is kept: offer "继续" next to "重试"
     */
    readonly resumable?: boolean;
}

/** "继续" in front of the rest of the row, when the version can be continued */
const keyboardStartingWithContinue = (resumable: boolean): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    if (resumable) keyboard.text('继续', `${CALLBACK_PREFIX}continue`);
    return keyboard;
};

/**
 * Build InlineKeyboard based on button state
 * Uses simple callback_data format: resp:action
 */
export const buildResponseButtons = (
    buttonState: ButtonState,
    currentVersionIndex: number = 0,
    totalVersions: number = 1,
    options: ResponseButtonOptions = {}
): InlineKeyboard | undefined => {
    const resumable = options.resumable === true;
    return match(buttonState)
        .with(ButtonState.PROCESSING, () =>
            new InlineKeyboard().text('停止', `${CALLBACK_PREFIX}stop`)
        )
        .with(ButtonState.RETRY_ONLY, () =>
            keyboardStartingWithContinue(resumable).text('重试', `${CALLBACK_PREFIX}retry`)
        )
        // An edit does not block continuing (D11): the user picks either
        .with(ButtonState.EDIT_DETECTED, () =>
            keyboardStartingWithContinue(resumable).text('检测到用户编辑，是否重试', `${CALLBACK_PREFIX}retry`)
        )
        .with(ButtonState.HAS_VERSIONS, () => {
            const kb = new InlineKeyboard();

            if (currentVersionIndex > 0) {
                kb.text('<', `${CALLBACK_PREFIX}prev`);
            }

            if (resumable) {
                kb.text('继续', `${CALLBACK_PREFIX}continue`);
            }

            kb.text('重试', `${CALLBACK_PREFIX}retry`);

            if (currentVersionIndex < totalVersions - 1) {
                kb.text('>', `${CALLBACK_PREFIX}next`);
            }

            return kb;
        })
        .otherwise(() => undefined);
};
