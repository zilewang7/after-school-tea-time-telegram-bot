import { Menu } from "@grammyjs/menu";
import { Bot } from "grammy";
import { changeModel } from "../util";


export const useCheckModelMenu = (bot: Bot) => {
    const menu = new Menu("checkModelMenu")
    .text("gpt-4o-2024-08-06", async (ctx) => await changeModel(ctx, bot, "gpt-4o-2024-08-06"))
    .text("gpt-4-turbo-2024-04-09", async (ctx) => await changeModel(ctx, bot, "gpt-4-turbo-2024-04-09")).row()
    .text("gemini-1.5-flash", async (ctx) => await changeModel(ctx, bot, "gemini-1.5-flash"))
    .text("gemini-1.5-pro", async (ctx) => await changeModel(ctx, bot, "gemini-1.5-pro")).row()

    bot.use(menu);

    return menu;
}