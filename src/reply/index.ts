import { Telegraf } from "telegraf";
import { replyChat } from "./chat";

export const replyLoad = (bot: Telegraf) => {
    bot.hears('hi', (ctx) => ctx.reply('Hey there'))
    bot.hears('图图', (ctx) => ctx.sendPhoto('https://img.heimao.icu/gpt-icon.png'))

    bot.hears('RickRoll', async (ctx) => ctx.sendVideo("https://img.heimao.icu/RickRoll"));
    bot.hears('炎忍', async (ctx) => ctx.reply("https://img.heimao.icu/yarn"));
    bot.hears('K-ON', ctx => ctx.react('🏆'))

    replyChat(bot);

    // bot.on(message('sticker'), (ctx) => ctx.sendSticker("CAACAgUAAx0CWYg6vQACCv1mk5aHEBJZ2FlsVUBD7OP0RkR8bgACcAcAAgmYeVQc09KxXTORsjUE"))
}