/**
 * The chat thinking-effort setting: its closed set, its Chinese labels and the
 * option list a model offers (thinking-effort design 2026-1113-1742 §1.2/§5).
 * One module so the write rules, the PATCH body and the chat view cannot drift
 * apart.
 *
 * The stored value is NULL (the model default), 'off' (thinking switched off)
 * or one of the graded efforts. Whether the current model accepts a value is
 * not decided here: the setting is free text relative to the model and the
 * runtime resolves what actually goes out.
 */
import { MODEL_EFFORTS, type ModelCatalogReasoning, type ModelEffort } from '../config/model-capabilities.js';

/** A toggle model's "thinking off" value */
export const THINKING_EFFORT_OFF = 'off';

export type ThinkingEffortValue = ModelEffort | typeof THINKING_EFFORT_OFF;

/** The closed set a PATCH accepts: null (model default) is not a string value */
export const THINKING_EFFORT_VALUES: readonly ThinkingEffortValue[] = [...MODEL_EFFORTS, THINKING_EFFORT_OFF];

/** The label of the value that means "no choice, the model decides" */
export const THINKING_EFFORT_DEFAULT_LABEL = '模型默认';

/** Chinese label of every value, including the off switch */
export const THINKING_EFFORT_LABELS: Readonly<Record<ThinkingEffortValue, string>> = {
    none: '无',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
    ultra: '极限',
    off: '关闭思考',
};

/** One graded effort of a model, as the panel's chips show it */
export interface ThinkingEffortOptionView {
    readonly value: ModelEffort;
    readonly label: string;
}

export type ThinkingEffortNormalization =
    | { readonly ok: true; readonly value: ThinkingEffortValue | null }
    | { readonly ok: false; readonly message: string };

/**
 * null, 'off' or a graded effort; anything else is refused. Only the closed set
 * is checked here — a value the current model does not offer is stored anyway
 * (the model is free text and changes).
 */
export const normalizeThinkingEffort = (raw: unknown): ThinkingEffortNormalization => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: '思考等级必须是字符串或 null' };
    const value = THINKING_EFFORT_VALUES.find((candidate) => candidate === raw);
    if (value === undefined) {
        return { ok: false, message: '思考等级必须是 null、off 或模型支持的档位' };
    }
    return { ok: true, value };
};

/**
 * A stored value read back. Only this service writes the column, so a value
 * outside the closed set means a hand-edited database: say so and behave as
 * "the model default" rather than guess.
 */
export const storedThinkingEffortOf = (text: string | null): ThinkingEffortValue | null => {
    if (text === null) return null;
    const normalized = normalizeThinkingEffort(text);
    if (!normalized.ok) {
        console.warn(`[thinking-effort] ignoring an invalid stored value: ${text}`);
        return null;
    }
    return normalized.value;
};

/** The graded efforts a model's reasoning section offers, in catalog order */
export const thinkingEffortOptionsOf = (
    reasoning: ModelCatalogReasoning | null | undefined
): readonly ThinkingEffortOptionView[] =>
    (reasoning?.efforts ?? []).map((effort) => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] }));

/** Whether the model offers any graded effort at all */
export const thinkingEffortSupportedOf = (reasoning: ModelCatalogReasoning | null | undefined): boolean =>
    (reasoning?.efforts ?? []).length > 0;
