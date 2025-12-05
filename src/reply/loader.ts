/**
 * Reply module loader
 */
import type { Bot } from 'grammy';
import type { Menus } from '../cmd/menu';
import { registerChatHandler } from './chat-handler';

/**
 * Load reply handlers on bot
 */
export const replyLoad = (bot: Bot, menus: Menus): void => {
    // Easter eggs
    bot.hears('RickRoll', async (ctx) =>
        ctx.replyWithVideo('https://img.heimao.icu/RickRoll')
    );
    bot.hears('K-ON', (ctx) => ctx.react('🏆'));

    // Register main chat handler
    registerChatHandler(bot, menus.retryMenu);
};
