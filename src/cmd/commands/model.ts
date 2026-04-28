import { Bot } from "grammy";
import { changeModel, sendModelMsg } from "../menu.js";

export const registerModelCommand = (bot: Bot) => {
    bot.command("model", async (ctx) => {
        const match = ctx.match;

        if (match) {
            await changeModel(ctx, match);
        } else {
            await sendModelMsg(ctx);
        }
    });
};
