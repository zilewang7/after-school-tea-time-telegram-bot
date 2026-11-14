/**
 * The refusal of a chat reply whose model is an image model. The settings
 * refuse such a model, but a value stored before that rule, or the
 * DEFAULT_MODEL env, can still name one. The reply then stops before its
 * placeholder and the stored value stays: a silent fallback would answer with
 * another model without saying why.
 */
import type { Context } from 'grammy';
import { isImageOutputModel } from '../ai/model-kinds.js';
import { sendBotNotice } from '../services/bot-notice-service.js';

/** The stored id is echoed: the /model overview shows it anyway */
export const imageChatModelRefusalText = (model: string): string =>
    `当前对话模型 ${model} 是生图模型，不能用来对话。用 /model 换一个对话模型（/model default 跟随全局默认）；` +
    '要画图直接让 bot 画，或用 /picbanana、/picgpt。';

/** Sends the refusal when `model` is an image model; resolves true when it refused (the caller then stops) */
export const refuseImageChatModel = async (ctx: Context, model: string): Promise<boolean> => {
    if (!isImageOutputModel(model)) return false;
    await sendBotNotice(ctx, imageChatModelRefusalText(model));
    return true;
};
