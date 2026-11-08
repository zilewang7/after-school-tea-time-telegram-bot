import { Bot } from "grammy";
import { sendBotNotice } from "../../services/bot-notice-service.js";

export const registerStartCommand = (bot: Bot) => {
    bot.command("start", (ctx) => sendBotNotice(ctx, "Welcome"));
};
