import type { Bot } from "grammy";
import { changeModel, sendModelMsg } from "../menu.js";

/** `/model` shows this chat's model; `/model <id>` or `/model default` changes it */
export const registerModelCommand = (bot: Bot) => {
    bot.command("model", async (ctx) => {
        const requested = ctx.match.trim();

        if (requested) {
            await changeModel(ctx, requested);
        } else {
            await sendModelMsg(ctx);
        }
    });
};
