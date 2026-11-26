/**
 * Text of the /model menu, built as entities. A model id is free text and may
 * hold any character; a backtick in it broke the old legacy-Markdown message
 * with a 400, entities never need escaping.
 *
 * The same overview also states the chat's thinking level (thinking-effort
 * design 2026-1113-1742 §4.1): the stored value, its source and — for a value
 * the current model does not offer — the fact that the vendor default applies.
 * A change replaces the overview with a record of that change, for the model
 * and the thinking level alike.
 */
import { match } from 'ts-pattern';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import type { ModelEffort } from '../config/model-capabilities.js';
import { codePolicyDefaultEffortOf } from '../ai/thinking-effort.js';
import {
    THINKING_EFFORT_DEFAULT_LABEL,
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    THINKING_EFFORT_OFF_LABEL,
    type ThinkingEffort,
} from '../shared/contracts/thinking-effort.js';
import { codeText, plainText } from '../telegram/formatters/entity-text.js';

export { codePolicyDefaultEffortOf };

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
    readonly value: ThinkingEffort | null;
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

/** What a thinking-level change reports: the new value and the stored one it replaced */
export interface ThinkingSwitchView {
    readonly current: ChatMenuView;
    /** The chat's thinking view before the change */
    readonly previous: ChatThinkingView;
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
    if (thinking.value === null) return `${THINKING_EFFORT_DEFAULT_LABEL}（${defaultThinkingTextOf(thinking)}）`;
    if (thinking.value === THINKING_EFFORT_OFF) {
        if (!thinking.toggle) {
            return `${THINKING_EFFORT_OFF_LABEL}（本聊天设置；当前模型不支持该档位，将按厂商默认生效）`;
        }
        return `${THINKING_EFFORT_OFF_LABEL}（本聊天设置）`;
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

/**
 * The value a change record names: the stored choice only, without the source
 * or the applicability notes — the record tells what changed, not how it applies.
 */
const thinkingChoiceLabelOf = (thinking: ChatThinkingView): string => {
    if (thinking.value === null) return `${THINKING_EFFORT_DEFAULT_LABEL}（${defaultThinkingTextOf(thinking)}）`;
    if (thinking.value === THINKING_EFFORT_OFF) return THINKING_EFFORT_OFF_LABEL;
    return THINKING_EFFORT_LABELS[thinking.value];
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

/**
 * After a thinking-level change: the same record a model switch leaves, so the
 * menu message says what changed, what it replaced and when — the plain
 * overview would hide the fact that a change just happened.
 */
export const renderThinkingSwitch = (change: ThinkingSwitchView): RenderedMessage =>
    concatMessages(
        plainText('思考等级切换为：'),
        plainText(thinkingChoiceLabelOf(change.current.thinking)),
        plainText('\n当前模型：'),
        codeText(change.current.model.model),
        plainText(sourceNoteOf(change.current.model.source)),
        plainText('\n上一个思考等级：'),
        plainText(thinkingChoiceLabelOf(change.previous)),
        plainText('\n操作时间：'),
        codeText(change.actionTime),
        FOOTER
    );
