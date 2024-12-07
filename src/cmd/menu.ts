import { Menu } from "@grammyjs/menu";
import { Bot, Context } from "grammy";
import { changeModel, retry } from "../util";

export type Menus = Record<'checkModelMenu' | 'retryMenu', Menu<Context>>

export const menuLoad = (bot: Bot): Menus => {
    const checkModelMenu = new Menu("checkModelMenu")
        .text("gpt-4o-2024-11-20", async (ctx): Promise<void> => await changeModel(ctx, "gpt-4o-2024-11-20", checkModelMenu))
        .text("o1-preview-2024-09-12", async (ctx): Promise<void> => await changeModel(ctx, "o1-preview-2024-09-12", checkModelMenu)).row()
        .text("gemini-1.5-flash", async (ctx): Promise<void> => await changeModel(ctx, "gemini-1.5-flash", checkModelMenu))
        .text("gemini-exp-1206", async (ctx): Promise<void> => await changeModel(ctx, "gemini-exp-1206", checkModelMenu)).row()
        .text("claude-3-5-sonnet-20241022", async (ctx): Promise<void> => await changeModel(ctx, "claude-3-5-sonnet-20241022", checkModelMenu))
        .text("claude-3-5-sonnet-20240620", async (ctx): Promise<void> => await changeModel(ctx, "claude-3-5-sonnet-20240620", checkModelMenu)).row()


    const retryMenu = new Menu("retryMenu")
        .text("重试", async (ctx): Promise<void> => await retry(ctx, retryMenu));

    bot.use(checkModelMenu, retryMenu);

    return {
        checkModelMenu,
        retryMenu
    }
}