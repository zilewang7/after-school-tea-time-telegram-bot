import { Bot } from "grammy";
import { Menus } from "../cmd/menu";
import { replyChat } from "./chat";

export const replyLoad = (bot: Bot, menus: Menus) => {
    // easter eggs
    bot.hears('RickRoll', async (ctx) => ctx.replyWithVideo("https://img.heimao.icu/RickRoll"));
    bot.hears('K-ON', ctx => ctx.react('🏆'));

    replyChat(bot, menus);
};
