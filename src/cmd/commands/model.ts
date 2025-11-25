import { Bot } from "grammy";
import { changeModel, sendModelMsg } from "../../util";
import { Menus } from "../menu";

export const registerModelCommand = (bot: Bot, menus: Menus) => {
    bot.command("model", async (ctx) => {
        const match = ctx.match;

        if (match) {
            await changeModel(ctx, match, menus.checkModelMenu);
        } else {
            await sendModelMsg(ctx, menus.checkModelMenu);
        }
    });
};
