/**
 * Owner-only widget maintenance commands.
 *
 * Phase 0 ships the widget path switched off; these commands answer "can it be
 * switched on yet?" without touching config. Registered as handlers only — they
 * stay out of the command menu, and every other user gets no reply at all.
 */
import type { Bot } from 'grammy';
import { formatWidgetStatus, runWidgetChatProbe } from '../../telegram/widget-readiness.js';

/** The owner is the only one who may probe Telegram's rollout from the bot */
const ownerId = (): number => Number.parseInt(process.env.OWNER_USER_ID ?? '', 10);

const isOwner = (user: { readonly id: number } | undefined): boolean => {
    const id = ownerId();
    return Number.isFinite(id) && user?.id === id;
};

export const registerWidgetCommands = (bot: Bot): void => {
    bot.command('widget_status', async (ctx) => {
        if (!isOwner(ctx.from)) return;
        try {
            await ctx.reply(await formatWidgetStatus());
        } catch (error) {
            console.error('[widget] /widget_status failed:', error);
            await ctx.reply('取 widget 状态失败，见日志。');
        }
    });

    bot.command('widget_probe', async (ctx) => {
        if (!isOwner(ctx.from)) return;
        const raw = ctx.match.trim();
        const parsed = raw.length > 0 ? Number.parseInt(raw, 10) : ctx.chat?.id;
        if (parsed === undefined || !Number.isFinite(parsed)) {
            await ctx.reply('用法：/widget_probe <chat_id>（省略则探当前聊天）');
            return;
        }
        try {
            await ctx.reply(await runWidgetChatProbe(parsed));
        } catch (error) {
            console.error('[widget] /widget_probe failed:', error);
            await ctx.reply('widget 探测失败，见日志。');
        }
    });
};
