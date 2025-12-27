/**
 * Reply module loader
 */
import type { Bot } from 'grammy';
import { registerChatHandler } from './chat-handler';

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
};
