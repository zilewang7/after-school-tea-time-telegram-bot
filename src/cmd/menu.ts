/**
 * Bot menus - model selection and retry buttons
 */
import { Menu } from '@grammyjs/menu';
import type { Bot, Context } from 'grammy';
import { changeModel } from '../util';
import { modelConfigs } from '../config/models';
import { setRetryHandler, registerResponseCallbacks } from './menus';
import { handleRetryRequest } from '../reply/retry-handler';

export type Menus = Record<'checkModelMenu', Menu<Context>>;

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
 * Load menus on bot
 */
export const menuLoad = (bot: Bot): Menus => {
    const checkModelMenu = createModelMenu();

    // Register Grammy menus
    bot.use(checkModelMenu);

    // Register response button callbacks (uses raw callback_query handler)
    registerResponseCallbacks(bot);

    // Set up retry handler
    setRetryHandler(handleRetryRequest);

    return {
        checkModelMenu,
    };
};
