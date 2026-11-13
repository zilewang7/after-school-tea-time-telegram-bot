/**
 * Text of the /model menu, built as entities. A model id is free text and may
 * hold any character; a backtick in it broke the old legacy-Markdown message
 * with a 400, entities never need escaping.
 *
 * The same overview also states the chat's thinking level (thinking-effort
 * design 2026-1113-1742 §4.1): the stored value, its source and — for a value
 * the current model does not offer — the fact that the vendor default applies.
 */
import { match } from 'ts-pattern';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import type { ModelEffort } from '../config/model-capabilities.js';
import { THINKING_EFFORT_LABELS, type ThinkingEffortValue } from '../services/thinking-effort-values.js';
import { codeText, plainText } from '../telegram/formatters/entity-text.js';

/** Where a chat's model comes from */
export type ModelSource = 'global' | 'chat';

export interface ChatModelView {
    /** The model the chat replies with */
    model: string;
    source: ModelSource;
}

/**
 * What the thinking keyboard needs about the current model (design §4.3).
 * `value` is the stored setting; the offered efforts come from the catalog
 * data, with the code policy only filling the display default of an unknown
 * model.
 */
export interface ChatThinkingView {
    /** Stored setting: null = model default, 'off', or a graded effort */
    readonly value: ThinkingEffortValue | null;
    /** The graded efforts the current model offers, in catalog order */
    readonly efforts: readonly ModelEffort[];
    /** Vendor default effort; null = unknown or a toggle-only model */
    readonly defaultEffort: ModelEffort | null;
    /** A toggle model's vendor default enabled state; null = not applicable/unknown */
    readonly defaultEnabled: boolean | null;
    /** Whether the model can switch thinking off/on */
    readonly toggle: boolean;
    /** Whether the model offers any graded effort */
    readonly supported: boolean;
}

/** The current model plus the thinking facts its menu renders */
export interface ChatMenuView {
    readonly model: ChatModelView;
    readonly thinking: ChatThinkingView;
}

export interface ModelSwitchView {
    readonly current: ChatMenuView;
    readonly previousModel: string;
    /** See formatActionTime */
    readonly actionTime: string;
}

const FOOTER: RenderedMessage = concatMessages(
    plainText('\n\n只对本聊天生效。点击下方按钮选择模型或思考等级，也可用 '),
    codeText('/model '),
    plainText('+模型名 手动指定')
);

const sourceNoteOf = (source: ModelSource): string =>
    match(source)
        .with('global', () => '（跟随全局默认）')
        .with('chat', () => '（本聊天单独设置）')
        .exhaustive();

/** Clock time of a change, always labeled with the zone it is shown in */
export const formatActionTime = (date: Date = new Date()): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    return `${date.toLocaleTimeString('zh-CN', { hour12: false, timeZone })} ${timeZone}`;
};

/** The enabled state a toggle model boots with, or its graded default */
const defaultThinkingTextOf = (thinking: ChatThinkingView): string => {
    if (thinking.toggle && thinking.defaultEnabled !== null) {
        return thinking.defaultEnabled ? '思考开' : '思考关';
    }
    if (thinking.defaultEffort !== null) return THINKING_EFFORT_LABELS[thinking.defaultEffort];
    return '由模型决定';
};

/**
 * The thinking line of the overview: the stored value with its source, or —
 * when the current model does not offer it — what actually happens next
 * (design §4.3: switching models never clears the stored value).
 */
export const thinkingSummaryOf = (thinking: ChatThinkingView): string => {
    if (thinking.value === null) return `模型默认（${defaultThinkingTextOf(thinking)}）`;
    if (thinking.value === 'off') {
        if (!thinking.toggle) {
            return '关闭思考（本聊天设置；当前模型不支持该档位，将按厂商默认生效）';
        }
        return '关闭思考（本聊天设置）';
    }
    const label = THINKING_EFFORT_LABELS[thinking.value];
    // Toggle-only model: a graded value cannot apply, so the vendor default wins.
    if (!thinking.supported) {
        return `${label}（本聊天设置；当前模型不支持该档位，将按厂商默认生效）`;
    }
    // The model has graded levels but not this one: the resolver clamps down
    // and sends the nearest supported level, so the note must say that.
    if (!thinking.efforts.includes(thinking.value)) {
        return `${label}（本聊天设置；当前模型不支持该档位，将按最接近的受支持档生效）`;
    }
    return `${label}（本聊天设置）`;
};

const openaiReasoningPrefixes: readonly string[] = ['gpt-5', 'gpt-6', 'o1', 'o3', 'o4'];

/**
 * The default level today's code hardcodes for a model the catalog does not
 * describe. Display only: the request path keeps the platform's own policy
 * until the data switch, and a catalog/seed `defaultEffort` always wins.
 */
export const codePolicyDefaultEffortOf = (model: string): ModelEffort | null => {
    const id = model.toLowerCase();
    // Chat variants are handled as non-reasoning by the OpenAI platform
    if (id.includes('chat')) return null;
    if (id.startsWith('gemini-4-hydrogen')) return 'xhigh';
    if (id.startsWith('gemini-4')) return 'high';
    if (openaiReasoningPrefixes.some((prefix) => id.startsWith(prefix))) return 'xhigh';
    if (id.includes('multi-agent')) return 'high';
    return null;
};

/** `/model` without an argument: the chat's model, thinking level and sources */
export const renderModelOverview = (view: ChatMenuView): RenderedMessage =>
    concatMessages(
        plainText('当前模型：'),
        codeText(view.model.model),
        plainText(sourceNoteOf(view.model.source)),
        plainText('\n思考等级：'),
        plainText(thinkingSummaryOf(view.thinking)),
        FOOTER
    );

/**
 * After a change. Only "follow the global default" is marked: a chat's own
 * model is what the user just picked, so it needs no note.
 */
export const renderModelSwitch = (change: ModelSwitchView): RenderedMessage =>
    concatMessages(
        plainText('切换为：'),
        codeText(change.current.model.model),
        plainText(change.current.model.source === 'global' ? sourceNoteOf('global') : ''),
        plainText('\n思考等级：'),
        plainText(thinkingSummaryOf(change.current.thinking)),
        plainText('\n上一个模型：'),
        codeText(change.previousModel),
        plainText('\n操作时间：'),
        codeText(change.actionTime),
        FOOTER
    );
