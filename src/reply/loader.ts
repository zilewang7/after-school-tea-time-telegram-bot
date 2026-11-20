/**
 * Reply module loader
 */
import type { Bot } from 'grammy';
import { recordBotReaction } from '../db/queries/reaction-queries.js';
import { setContinueHandler } from '../cmd/menus/response-menu.js';
import { registerChatHandler } from './chat-handler.js';
import { handleContinueClick } from './resume/continue-click.js';

/**
 * Load reply handlers on bot
 */
export const replyLoad = (bot: Bot): void => {
    // Easter eggs
    bot.hears('RickRoll', async (ctx) =>
        ctx.replyWithVideo('https://img.heimao.icu/RickRoll')
    );
    bot.hears('K-ON', async (ctx) => {
        if (!ctx.chat || !ctx.message) return;
        try {
            await ctx.react('🏆');
        } catch (error) {
            console.warn('[loader] K-ON reaction failed:', error instanceof Error ? error.message : error);
            return;
        }
        // The Bot API never reports the bot's own reaction as an update
        await recordBotReaction(ctx.chat.id, ctx.message.message_id, '🏆');
    });

    // Register main chat handler (buttons handled via buildResponseButtons)
    registerChatHandler(bot);

    // "继续" on a failed or stopped reply: the button handler claims the
    // reply, this layer checks the kept checkpoint and runs the resume
    setContinueHandler((ctx, response) => handleContinueClick(ctx, response));
};
