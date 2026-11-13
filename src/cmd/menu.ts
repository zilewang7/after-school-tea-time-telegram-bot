/**
 * Bot menus - model selection, thinking level and response buttons
 *
 * The model and thinking menus read and write the current chat's own settings:
 * `/model` and the `mdl:`/`thk:` buttons never change another chat. Writes go
 * through updateChatSettings, which persists, updates the cache and audits.
 *
 * The thinking keyboard (thinking-effort design 2026-1113-1742 §4.3) offers the
 * current model's catalog efforts plus the toggle and the model default; the
 * stored setting is free text relative to the model, so a value the current
 * model does not offer is shown with a vendor-default note, never cleared.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import type { RenderedMessage } from 'telegram-md-entities';
import { listModelCatalog } from '../config/model-catalog.js';
import { resolveChatModel } from '../config/chat-model.js';
import { isOwnerUser } from '../config/owner.js';
import { resolveAccessTier } from '../services/access-tier.js';
import { resolveModelTraits } from '../ai/model-traits.js';
import { TRIAL_CALLBACK_REFUSAL_TEXT, TRIAL_MODEL_REFUSAL_TEXT } from '../reply/commands/trial-refusal.js';
import {
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    normalizeThinkingEffort,
    type ThinkingEffortValue,
} from '../services/thinking-effort-values.js';
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
    codePolicyDefaultEffortOf,
    formatActionTime,
    renderModelOverview,
    renderModelSwitch,
    type ChatMenuView,
    type ChatModelView,
    type ChatThinkingView,
} from './model-menu-text.js';
import {
    registerCapabilityApprovalCallbacks,
    registerGenerationCallbacks,
    registerResponseCallbacks,
    setRetryHandler,
} from './menus/index.js';
import { registerPriceApprovalCallbacks } from './menus/price-approval-menu.js';
import { handleRetryRequest } from '../reply/retry-handler.js';

const MODEL_PREFIX = 'mdl:';
const THINKING_PREFIX = 'thk:';
/** `/model default` and `mdl:default`: drop the chat's own model */
const FOLLOW_GLOBAL_REQUEST = 'default';
const BUTTONS_PER_ROW = 2;

/** The default menu offers the two sub-menus in one row (design §4.1) */
const buildDefaultMenuKeyboard = (): InlineKeyboard =>
    new InlineKeyboard()
        .text('🧩 模型选择', `${MODEL_PREFIX}expand`)
        .text('🧠 思考等级', `${THINKING_PREFIX}expand`);

const buildExpandedModelKeyboard = (): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    // The registry (DB-backed once loaded, the built-in menu before that);
    // any model the owner allows enters the menu without a release
    listModelCatalog().forEach((model, index) => {
        keyboard.text(model.label, `${MODEL_PREFIX}${model.id}`);
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

/**
 * What the thinking menu needs about the current model: catalog efforts and
 * toggle from the traits resolver, the display default from the data (with the
 * code policy only filling an unknown model).
 */
const chatThinkingViewOf = (chatId: number): ChatThinkingView => {
    const model = resolveChatModel(chatId);
    const reasoning = resolveModelTraits(model).capabilities?.reasoning;
    const efforts = reasoning?.efforts ?? [];
    return {
        value: getChatSettings(chatId)?.thinkingEffort ?? null,
        efforts,
        defaultEffort: reasoning?.defaultEffort ?? codePolicyDefaultEffortOf(model),
        defaultEnabled: reasoning?.defaultEnabled ?? null,
        toggle: reasoning?.toggle === true,
        supported: efforts.length > 0,
    };
};

const chatMenuViewOf = (chatId: number): ChatMenuView => ({
    model: chatModelViewOf(chatId),
    thinking: chatThinkingViewOf(chatId),
});

const markSelected = (selected: boolean): string => (selected ? '✓ ' : '');

/** The thinking-level keyboard: toggle, graded efforts, model default, back */
const buildThinkingKeyboard = (chatId: number): InlineKeyboard => {
    const view = chatThinkingViewOf(chatId);
    const keyboard = new InlineKeyboard();
    if (view.supported) {
        if (view.toggle) {
            // Design §4.3: a model that also switches thinking puts it first
            keyboard.text(`${markSelected(view.value === THINKING_EFFORT_OFF)}关闭思考`, `${THINKING_PREFIX}${THINKING_EFFORT_OFF}`);
            keyboard.row();
        }
        view.efforts.forEach((effort, index) => {
            keyboard.text(
                `${markSelected(view.value === effort)}${THINKING_EFFORT_LABELS[effort]}`,
                `${THINKING_PREFIX}${effort}`
            );
            if ((index + 1) % BUTTONS_PER_ROW === 0) keyboard.row();
        });
        // A half-filled row must be closed before the shared controls
        if (view.efforts.length % BUTTONS_PER_ROW !== 0) keyboard.row();
    } else if (view.toggle) {
        keyboard.text(`${markSelected(view.value === THINKING_EFFORT_OFF)}关闭思考`, `${THINKING_PREFIX}${THINKING_EFFORT_OFF}`);
        keyboard.row();
    }
    if (view.supported || view.toggle) {
        // A toggle-only model names its vendor default state (design §4.3)
        const defaultLabel =
            !view.supported && view.defaultEnabled !== null
                ? `模型默认（思考${view.defaultEnabled ? '开' : '关'}）`
                : '模型默认';
        keyboard.text(`${markSelected(view.value === null)}${defaultLabel}`, `${THINKING_PREFIX}default`);
        keyboard.row();
    }
    keyboard.text('收起', `${THINKING_PREFIX}back`);
    return keyboard;
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

const thinkingRefusalNoticeOf = (code: ChatSettingsErrorCode): string =>
    match(code)
        .with('locked', () => '本聊天的设置已被机主锁定')
        .with('invalid', () => '思考等级无效')
        .with('forbidden', () => '没有权限修改本聊天的设置')
        .with('conflict', () => '设置刚被他人修改，请重试')
        .with('trial', () => '体验用户不能修改思考等级；申请准入后可以修改')
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

    const current = chatMenuViewOf(chatId);
    return {
        kind: 'changed',
        text: renderModelSwitch({ current, previousModel, actionTime: formatActionTime() }),
        toast: followGlobal ? `已改为跟随全局默认（当前 ${current.model.model}）` : `已切换到 ${current.model.model}`,
    };
};

type ThinkingChangeOutcome =
    | { kind: 'changed'; text: RenderedMessage; toast: string }
    | { kind: 'refused'; notice: string };

const thinkingToastOf = (requested: ThinkingEffortValue | null): string => {
    if (requested === null) return '已恢复模型默认';
    if (requested === THINKING_EFFORT_OFF) return '已关闭思考';
    return `思考等级已设为 ${THINKING_EFFORT_LABELS[requested]}`;
};

/** Store one thinking setting; the menu then re-renders the overview */
const applyThinkingChange = async (
    chatId: number,
    userId: number,
    requested: ThinkingEffortValue | null
): Promise<ThinkingChangeOutcome> => {
    try {
        await updateChatSettings({
            chatId,
            patch: { thinkingEffort: requested },
            actor: { userId, isOwner: isOwnerUser(userId) },
        });
    } catch (error) {
        if (error instanceof ChatSettingsError) {
            return { kind: 'refused', notice: thinkingRefusalNoticeOf(error.code) };
        }
        throw error;
    }
    return {
        kind: 'changed',
        text: renderModelOverview(chatMenuViewOf(chatId)),
        toast: thinkingToastOf(requested),
    };
};

/** `default` stands for the model default; a graded effort or `off` is stored */
const thinkingValueOf = (action: string): ThinkingEffortValue | null | undefined => {
    if (action === 'default') return null;
    const normalized = normalizeThinkingEffort(action);
    return normalized.ok && normalized.value !== null ? normalized.value : undefined;
};

const replyWithModelText = async (ctx: Context, text: RenderedMessage): Promise<void> => {
    await sendBotNotice(ctx, text.text, {
        entities: toApiEntities(text.entities),
        reply_markup: buildDefaultMenuKeyboard(),
    });
};

export const sendModelMsg = async (ctx: Context): Promise<void> => {
    if (!ctx.chat) return;
    if ((await resolveAccessTier(ctx.from?.id ?? null, ctx.chat.id)) === 'trial') {
        await sendBotNotice(ctx, TRIAL_MODEL_REFUSAL_TEXT);
        return;
    }
    await replyWithModelText(ctx, renderModelOverview(chatMenuViewOf(ctx.chat.id)));
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
            reply_markup: buildDefaultMenuKeyboard(),
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

/** The thinking button of the default keyboard: expand, go back, or store a value */
const handleThinkingButton = async (ctx: Context, action: string): Promise<void> => {
    if (!ctx.chat || !ctx.from) {
        await ctx.answerCallbackQuery();
        return;
    }
    if (action === 'expand' || action === 'back') {
        const view = chatThinkingViewOf(ctx.chat.id);
        const keyboard = action === 'back' ? buildDefaultMenuKeyboard() : buildThinkingKeyboard(ctx.chat.id);
        const [markupError] = await to(ctx.editMessageReplyMarkup({ reply_markup: keyboard }));
        if (markupError) console.warn('[menu] thinking menu edit failed:', markupError.message);
        if (action === 'expand' && !view.supported && !view.toggle) {
            await ctx.answerCallbackQuery({ text: '当前模型不支持思考档位' });
            return;
        }
        await ctx.answerCallbackQuery();
        return;
    }

    const requested = thinkingValueOf(action);
    if (requested === undefined) {
        // A stale or unknown button: the menu moved on, nothing to store
        await ctx.answerCallbackQuery();
        return;
    }
    if ((await resolveAccessTier(ctx.from.id, ctx.chat.id)) === 'trial') {
        await ctx.answerCallbackQuery({ text: TRIAL_CALLBACK_REFUSAL_TEXT });
        return;
    }
    const outcome = await applyThinkingChange(ctx.chat.id, ctx.from.id, requested);
    if (outcome.kind === 'refused') {
        await ctx.answerCallbackQuery({ text: outcome.notice });
        return;
    }

    const [editError] = await to(
        ctx.editMessageText(outcome.text.text, {
            entities: toApiEntities(outcome.text.entities),
            reply_markup: buildDefaultMenuKeyboard(),
        })
    );
    if (editError) {
        console.warn('[menu] thinking menu edit failed:', editError.message);
    } else {
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
                await ctx.editMessageReplyMarkup({ reply_markup: buildDefaultMenuKeyboard() });
                await ctx.answerCallbackQuery();
            })
            .with('', async () => {
                await ctx.answerCallbackQuery();
            })
            .otherwise((requested) => handleModelButton(ctx, requested));
    });
};

/** `thk:` is registered on its own, so a tail never falls into `mdl:` (design §4.4) */
const registerThinkingCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith(THINKING_PREFIX)) {
            return next();
        }
        await handleThinkingButton(ctx, data.slice(THINKING_PREFIX.length).trim());
    });
};

/**
 * Load menus on bot
 */
export const menuLoad = (bot: Bot): void => {
    registerModelCallbacks(bot);
    registerThinkingCallbacks(bot);
    registerGenerationCallbacks(bot);
    registerResponseCallbacks(bot);
    registerPriceApprovalCallbacks(bot);
    registerCapabilityApprovalCallbacks(bot);
    setRetryHandler(handleRetryRequest);
};
