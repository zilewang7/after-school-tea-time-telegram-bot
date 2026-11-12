/**
 * Bot menus - model selection and response buttons
 *
 * The model menu reads and writes the current chat's own setting: `/model`
 * and the `mdl:` buttons never change another chat. Writes go through
 * updateChatSettings, which persists, updates the cache and audits.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import type { RenderedMessage } from 'telegram-md-entities';
import { modelConfigs } from '../config/models.js';
import { resolveChatModel } from '../config/chat-model.js';
import { isOwnerUser } from '../config/owner.js';
import { resolveAccessTier } from '../services/access-tier.js';
import { TRIAL_CALLBACK_REFUSAL_TEXT, TRIAL_MODEL_REFUSAL_TEXT } from '../reply/commands/trial-refusal.js';
import {
    ChatSettingsError,
    getChatSettings,
    updateChatSettings,
    type ChatSettingsErrorCode,
} from '../services/chat-settings-service.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { to } from '../shared/result.js';
import { sendBotNotice, updateBotNotice } from '../services/bot-notice-service.js';
import {
    formatActionTime,
    renderModelOverview,
    renderModelSwitch,
    type ChatModelView,
} from './model-menu-text.js';
import { setRetryHandler, registerResponseCallbacks, registerGenerationCallbacks } from './menus/index.js';
import { handleRetryRequest } from '../reply/retry-handler.js';

const MODEL_PREFIX = 'mdl:';
/** `/model default` and `mdl:default`: drop the chat's own model */
const FOLLOW_GLOBAL_REQUEST = 'default';
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
    keyboard.row().text('跟随全局默认', `${MODEL_PREFIX}${FOLLOW_GLOBAL_REQUEST}`);
    keyboard.row().text('收起', `${MODEL_PREFIX}collapse`);
    return keyboard;
};

const chatModelViewOf = (chatId: number): ChatModelView => {
    const ownModel = getChatSettings(chatId)?.model ?? null;
    return {
        model: resolveChatModel(chatId),
        source: ownModel === null ? 'global' : 'chat',
    };
};

const refusalNoticeOf = (code: ChatSettingsErrorCode): string =>
    match(code)
        .with('locked', () => '本聊天的设置已被机主锁定')
        // Callers never pass a blank id, so the only invalid id is a long one
        .with('invalid', () => '模型 id 过长')
        .with('forbidden', () => '没有权限修改本聊天的设置')
        // /model never sends an expected version, kept for exhaustiveness
        .with('conflict', () => '设置刚被他人修改，请重试')
        .with('trial', () => '体验用户不能修改模型；申请准入后可以修改')
        .exhaustive();

type ModelChangeOutcome =
    | { kind: 'changed'; text: RenderedMessage; toast: string }
    | { kind: 'refused'; notice: string };

/**
 * Set the chat's model to `requested` (a trimmed, non-empty id, or `default`
 * to follow the global default). Any id is accepted, menu or not; refusals
 * (locked chat, id too long) come back as a notice, never echoing the id.
 */
const applyModelChange = async (
    chatId: number,
    userId: number,
    requested: string
): Promise<ModelChangeOutcome> => {
    const previousModel = resolveChatModel(chatId);
    const followGlobal = requested === FOLLOW_GLOBAL_REQUEST;
    try {
        await updateChatSettings({
            chatId,
            patch: { model: followGlobal ? null : requested },
            actor: { userId, isOwner: isOwnerUser(userId) },
        });
    } catch (error) {
        if (error instanceof ChatSettingsError) {
            return { kind: 'refused', notice: refusalNoticeOf(error.code) };
        }
        throw error;
    }

    const current = chatModelViewOf(chatId);
    return {
        kind: 'changed',
        text: renderModelSwitch({ current, previousModel, actionTime: formatActionTime() }),
        toast: followGlobal ? `已改为跟随全局默认（当前 ${current.model}）` : `已切换到 ${current.model}`,
    };
};

const replyWithModelText = async (ctx: Context, text: RenderedMessage): Promise<void> => {
    await sendBotNotice(ctx, text.text, {
        entities: toApiEntities(text.entities),
        reply_markup: buildCollapsedModelKeyboard(),
    });
};

export const sendModelMsg = async (ctx: Context): Promise<void> => {
    if (!ctx.chat) return;
    if ((await resolveAccessTier(ctx.from?.id ?? null, ctx.chat.id)) === 'trial') {
        await sendBotNotice(ctx, TRIAL_MODEL_REFUSAL_TEXT);
        return;
    }
    await replyWithModelText(ctx, renderModelOverview(chatModelViewOf(ctx.chat.id)));
};

/** `/model <id>`; `requested` is already trimmed and non-empty */
export const changeModel = async (ctx: Context, requested: string): Promise<void> => {
    if (!ctx.chat || !ctx.from) return;
    if ((await resolveAccessTier(ctx.from.id, ctx.chat.id)) === 'trial') {
        await sendBotNotice(ctx, TRIAL_MODEL_REFUSAL_TEXT);
        return;
    }
    const outcome = await applyModelChange(ctx.chat.id, ctx.from.id, requested);
    await match(outcome)
        .with({ kind: 'refused' }, ({ notice }) => sendBotNotice(ctx, notice))
        .with({ kind: 'changed' }, ({ text }) => replyWithModelText(ctx, text))
        .exhaustive();
};

/** A model button (or 跟随全局默认): edit the menu in place, toast the result */
const handleModelButton = async (ctx: Context, requested: string): Promise<void> => {
    if (!ctx.chat || !ctx.from) {
        await ctx.answerCallbackQuery();
        return;
    }
    if ((await resolveAccessTier(ctx.from.id, ctx.chat.id)) === 'trial') {
        await ctx.answerCallbackQuery({ text: TRIAL_CALLBACK_REFUSAL_TEXT });
        return;
    }
    const outcome = await applyModelChange(ctx.chat.id, ctx.from.id, requested);
    if (outcome.kind === 'refused') {
        await ctx.answerCallbackQuery({ text: outcome.notice });
        return;
    }

    const [editError] = await to(
        ctx.editMessageText(outcome.text.text, {
            entities: toApiEntities(outcome.text.entities),
            reply_markup: buildCollapsedModelKeyboard(),
        })
    );
    if (editError) {
        console.warn('[menu] model menu edit failed:', editError.message);
    } else {
        // The menu message itself is the record of the switch: keep its stored
        // text in step, or a context would quote the model state from before
        const menuMessageId = ctx.callbackQuery?.message?.message_id;
        if (menuMessageId !== undefined) {
            await updateBotNotice(ctx, menuMessageId, outcome.text.text);
        }
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
};

const registerModelCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;

        if (!data.startsWith(MODEL_PREFIX)) {
            return next();
        }

        const action = data.slice(MODEL_PREFIX.length).trim();

        await match(action)
            .with('expand', async () => {
                await ctx.editMessageReplyMarkup({ reply_markup: buildExpandedModelKeyboard() });
                await ctx.answerCallbackQuery();
            })
            .with('collapse', async () => {
                await ctx.editMessageReplyMarkup({ reply_markup: buildCollapsedModelKeyboard() });
                await ctx.answerCallbackQuery();
            })
            .with('', async () => {
                await ctx.answerCallbackQuery();
            })
            .otherwise((requested) => handleModelButton(ctx, requested));
    });
};

/**
 * Load menus on bot
 */
export const menuLoad = (bot: Bot): void => {
    registerModelCallbacks(bot);
    registerGenerationCallbacks(bot);
    registerResponseCallbacks(bot);
    setRetryHandler(handleRetryRequest);
};
