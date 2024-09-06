import { Bot } from "grammy";
import { Menus } from "../cmd/menu";
import { replyChat } from "./chat";

export const replyLoad = (bot: Bot, menus: Menus) => {
    bot.hears('hi', (ctx) => ctx.reply('Hey there'))
    bot.hears('图图', (ctx) => ctx.replyWithPhoto('https://img.heimao.icu/gpt-icon.png'))

    bot.hears('RickRoll', async (ctx) => ctx.replyWithVideo("https://img.heimao.icu/RickRoll"));
    bot.hears('炎忍', async (ctx) => ctx.replyWithVideo("https://img.heimao.icu/yarn"));
    bot.hears('K-ON', ctx => ctx.react('🏆'))

    replyChat(bot, menus);

    // bot.on(message('sticker'), (ctx) => ctx.sendSticker("CAACAgUAAx0CWYg6vQACCv1mk5aHEBJZ2FlsVUBD7OP0RkR8bgACcAcAAgmYeVQc09KxXTORsjUE"))
}