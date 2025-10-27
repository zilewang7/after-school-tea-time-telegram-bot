import { Bot } from "grammy";
import { Menus } from "../cmd/menu";
import { replyChat } from "./chat";

export const replyLoad = (bot: Bot, menus: Menus) => {
    bot.hears('RickRoll', async (ctx) => ctx.replyWithVideo("https://img.heimao.icu/RickRoll"));
    bot.hears('K-ON', ctx => ctx.react('🏆'))

    replyChat(bot, menus);

    // bot.on(message('sticker'), (ctx) => ctx.sendSticker("CAACAgUAAx0CWYg6vQACCv1mk5aHEBJZ2FlsVUBD7OP0RkR8bgACcAcAAgmYeVQc09KxXTORsjUE"))
}