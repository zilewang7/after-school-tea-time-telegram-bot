/**
 * Reply module loader
 */
import type { Bot } from 'grammy';
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
    bot.hears('K-ON', (ctx) => ctx.react('🏆'));

    // Register main chat handler (buttons handled via buildResponseButtons)
    registerChatHandler(bot);

    // "继续" on a failed or stopped reply: the button handler claims the
    // reply, this layer checks the kept checkpoint and runs the resume
    setContinueHandler((ctx, response) => handleContinueClick(ctx, response));
};
