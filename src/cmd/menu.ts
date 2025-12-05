/**
 * Bot menus - model selection and retry buttons
 */
import { Menu } from '@grammyjs/menu';
import type { Bot, Context } from 'grammy';
import { changeModel, retry } from '../util';
import { modelConfigs } from '../config/models';

export type Menus = Record<'checkModelMenu' | 'retryMenu', Menu<Context>>;

const BUTTONS_PER_ROW = 2;

/**
 * Create model selection menu
 */
const createModelMenu = (): Menu<Context> => {
    const menu = new Menu<Context>('checkModelMenu');

    modelConfigs.forEach((model, index) => {
        menu.text(model.name, async (ctx) => {
            await changeModel(ctx, model.id, menu);
        });

        // Add row break after every BUTTONS_PER_ROW buttons
        if ((index + 1) % BUTTONS_PER_ROW === 0) {
            menu.row();
        }
    });

    return menu;
};

/**
 * Create retry menu
 */
const createRetryMenu = (): Menu<Context> => {
    const menu = new Menu<Context>('retryMenu');

    menu.text('重试', async (ctx) => {
        await retry(ctx, menu);
    });

    return menu;
};

/**
 * Load menus on bot
 */
export const menuLoad = (bot: Bot): Menus => {
    const checkModelMenu = createModelMenu();
    const retryMenu = createRetryMenu();

    bot.use(checkModelMenu, retryMenu);

    return {
        checkModelMenu,
        retryMenu,
    };
};
