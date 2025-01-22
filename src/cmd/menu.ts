import { Menu } from "@grammyjs/menu";
import { Bot, Context } from "grammy";
import { changeModel, retry } from "../util";
import { modelConfigs } from "../config/models";

export type Menus = Record<'checkModelMenu' | 'retryMenu', Menu<Context>>

export const menuLoad = (bot: Bot): Menus => {
    const checkModelMenu = new Menu("checkModelMenu");
    
    // 每行显示2个按钮
    const BUTTONS_PER_ROW = 2;
    modelConfigs.forEach((model, index) => {
        checkModelMenu.text(
            model.name,
            async (ctx) => await changeModel(ctx, model.id, checkModelMenu)
        );
        
        if ((index + 1) % BUTTONS_PER_ROW === 0) {
            checkModelMenu.row();
        }
    });

    const retryMenu = new Menu("retryMenu")
        .text("重试", async (ctx): Promise<void> => await retry(ctx, retryMenu));

    bot.use(checkModelMenu, retryMenu);

    return {
        checkModelMenu,
        retryMenu
    }
}