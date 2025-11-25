import { Bot } from "grammy";

export const registerStartCommand = (bot: Bot) => {
    bot.command("start", (ctx) => ctx.reply("Welcome"));
};
