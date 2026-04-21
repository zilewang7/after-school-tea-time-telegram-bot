/**
 * Bot menus - model selection and response buttons
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { modelConfigs } from '../config/models';
import { getCurrentModel, setCurrentModel } from '../state';
import { setRetryHandler, registerResponseCallbacks } from './menus';
import { handleRetryRequest } from '../reply/retry-handler';

const MODEL_PREFIX = 'mdl:';
const BUTTONS_PER_ROW = 2;

const buildCollapsedModelKeyboard = (): InlineKeyboard => {
    return new InlineKeyboard().text('展开快捷选择', `${MODEL_PREFIX}expand`);
};

const buildExpandedModelKeyboard = (): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    modelConfigs.forEach((model, index) => {
        keyboard.text(model.name, `${MODEL_PREFIX}${model.id}`);
        if ((index + 1) % BUTTONS_PER_ROW === 0) {
            keyboard.row();
        }
    });
    return keyboard;
};

const buildModelMessageText = (): string => {
    return '当前模型：`' + getCurrentModel() + '`\n\n点击下方按钮快速切换或使用 `/model `\\+模型名 手动指定';
};

export const sendModelMsg = async (ctx: Context): Promise<void> => {
    await ctx.reply(buildModelMessageText(), {
        reply_markup: buildCollapsedModelKeyboard(),
        parse_mode: 'Markdown',
    });
};

export const changeModel = async (ctx: Context, model: string): Promise<void> => {
    setCurrentModel(model);
    await sendModelMsg(ctx);
};

const registerModelCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;

        if (!data.startsWith(MODEL_PREFIX)) {
            return next();
        }

        const action = data.slice(MODEL_PREFIX.length);

        if (action === 'expand') {
            await ctx.editMessageReplyMarkup({ reply_markup: buildExpandedModelKeyboard() });
            await ctx.answerCallbackQuery();
            return;
        }

        setCurrentModel(action);
        await ctx.editMessageText(buildModelMessageText(), {
            parse_mode: 'Markdown',
            reply_markup: buildCollapsedModelKeyboard(),
        });
        await ctx.answerCallbackQuery({ text: `已切换到 ${action}` });
    });
};

/**
 * Load menus on bot
 */
export const menuLoad = (bot: Bot): void => {
    registerModelCallbacks(bot);
    registerResponseCallbacks(bot);
    setRetryHandler(handleRetryRequest);
};
