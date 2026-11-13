/**
 * `/pricing`: the owner's manual trigger of the price watcher (design §5.5).
 *
 * Hidden from the command menu and silent for everybody else: only the owner in
 * a private chat gets an answer, in their own chat. The handler does no
 * fetching itself — it drives the same `runPriceWatchNow` the daily timer uses,
 * so a manual run and a scheduled one cannot diverge, and it relays the run's
 * own summary.
 */
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import { isOwnerUser } from '../../config/owner.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';
import {
    formatPriceStatusText,
    runPriceWatchNow,
    watchRunSummary,
} from '../../services/price-watch-service.js';

/** Two manual runs closer together than this would only repeat the fetch */
const MANUAL_RUN_DEBOUNCE_MS = 2 * 60 * 1000;

const USAGE_TEXT = '用法：/pricing 立即巡检一次；/pricing status 查看价目状态';
const RUN_FAILED_TEXT = '巡检失败，详见日志。';
const STATUS_FAILED_TEXT = '读取价目状态失败，见日志。';

/** When the owner last triggered a run by hand; null before the first one */
let lastManualRunAt: number | null = null;

/** Only for tests: forget the debounce clock so cases do not depend on each other */
export const resetPricingCommandState = (): void => {
    lastManualRunAt = null;
};

const utcHourMinute = (timestamp: number): string =>
    new Date(timestamp).toISOString().slice(11, 16);

const reply = async (ctx: Context, text: string): Promise<void> => {
    await sendBotNotice(ctx, text);
};

const runNow = async (ctx: Context): Promise<void> => {
    const now = Date.now();
    const previous = lastManualRunAt;
    if (previous !== null && now - previous < MANUAL_RUN_DEBOUNCE_MS) {
        await reply(ctx, `刚刚已经跑过（上次 ${utcHourMinute(previous)} UTC）`);
        return;
    }
    lastManualRunAt = now;
    try {
        const result = await runPriceWatchNow(ctx.api, { trigger: 'manual' });
        // A busy or disabled run fetched nothing: the next /pricing may try again
        if (result.outcome === 'busy' || result.outcome === 'disabled') lastManualRunAt = previous;
        await reply(ctx, watchRunSummary(result));
    } catch (error: unknown) {
        // A failure before the run's own guards (the run row, the DB) still owes
        // the owner an answer
        console.error('[pricing] the manual price watch failed:', error);
        await reply(ctx, RUN_FAILED_TEXT);
    }
};

const showStatus = async (ctx: Context): Promise<void> => {
    try {
        await reply(ctx, await formatPriceStatusText());
    } catch (error: unknown) {
        console.error('[pricing] reading the price status failed:', error);
        await reply(ctx, STATUS_FAILED_TEXT);
    }
};

/** The text after `/pricing`; a non-text context has none */
const argumentOf = (ctx: Context): string => (typeof ctx.match === 'string' ? ctx.match.trim() : '');

/** Owner, private chat, known argument; everything else is ignored silently */
const handlePricing = async (ctx: Context): Promise<void> => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from?.id;
    if (userId === undefined || !isOwnerUser(userId)) return;
    await match(argumentOf(ctx))
        .with('', () => runNow(ctx))
        .with('status', () => showStatus(ctx))
        .otherwise(() => reply(ctx, USAGE_TEXT));
};

/** Registered as a handler only: the command stays out of `setMyCommands` */
export const registerPricingCommand = (bot: Bot): void => {
    bot.command('pricing', (ctx) => handlePricing(ctx));
};
