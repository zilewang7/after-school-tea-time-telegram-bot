import { Menu } from "@grammyjs/menu";
import { Bot, Context } from "grammy";
import { changeModel } from "../util";

export type Menus = Record<'checkModelMenu', Menu<Context>>

export const menuLoad = (bot: Bot): Menus => {
    const checkModelMenu = new Menu("checkModelMenu")
        .text("gpt-4o-2024-08-06", async (ctx): Promise<void> => await changeModel(ctx, "gpt-4o-2024-08-06", checkModelMenu))
        .text("gpt-4-turbo-2024-04-09", async (ctx): Promise<void> => await changeModel(ctx, "gpt-4-turbo-2024-04-09", checkModelMenu)).row()
        .text("gemini-1.5-flash", async (ctx): Promise<void> => await changeModel(ctx, "gemini-1.5-flash", checkModelMenu))
        .text("gemini-1.5-pro", async (ctx): Promise<void> => await changeModel(ctx, "gemini-1.5-pro", checkModelMenu)).row()

    bot.use(checkModelMenu);

    return {
        checkModelMenu,
    }
}