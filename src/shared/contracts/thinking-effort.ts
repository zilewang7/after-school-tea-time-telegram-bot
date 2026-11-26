/**
 * Canonical thinking-effort values, labels, and normalization shared by the
 * backend (capability catalog, chat settings, /model menu) and the Mini App.
 *
 * Pure TypeScript with zero Node/DOM/external dependencies.
 */

/** Graded thinking efforts, ascending: a user selection may be clamped down within it */
export const THINKING_EFFORT_ORDER = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const;

export type GradedThinkingEffort = (typeof THINKING_EFFORT_ORDER)[number];

/** A toggle model's "thinking off" value, as chat_settings stores it */
export const THINKING_EFFORT_OFF = 'off' as const;

/** The closed set of stored string values (null = model default is not a string value) */
export const THINKING_EFFORT_VALUES = [...THINKING_EFFORT_ORDER, THINKING_EFFORT_OFF] as const;

export type ThinkingEffort = (typeof THINKING_EFFORT_VALUES)[number];

const GRADED_EFFORT_SET: ReadonlySet<string> = new Set(THINKING_EFFORT_ORDER);
const THINKING_EFFORT_SET: ReadonlySet<string> = new Set(THINKING_EFFORT_VALUES);

export const isGradedThinkingEffort = (value: string): value is GradedThinkingEffort =>
    GRADED_EFFORT_SET.has(value);

export const isThinkingEffort = (value: string): value is ThinkingEffort =>
    THINKING_EFFORT_SET.has(value);

/** Field and audit-key label */
export const THINKING_EFFORT_LABEL = '思考等级';

/** Label of the null value ("no choice, the model decides") */
export const THINKING_EFFORT_DEFAULT_LABEL = '模型默认';

/** Chinese label of every closed-set value, including the off switch */
export const THINKING_EFFORT_LABELS: Readonly<Record<ThinkingEffort, string>> = {
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

/** Label of the toggle-off choice */
export const THINKING_EFFORT_OFF_LABEL: string = THINKING_EFFORT_LABELS[THINKING_EFFORT_OFF];

/** Chinese label of a thinking-effort string; unknown values are returned as-is */
export const thinkingEffortLabel = (value: string): string =>
    isThinkingEffort(value) ? THINKING_EFFORT_LABELS[value] : value;

/** One graded effort option as exposed to the panel UI */
export interface ThinkingEffortOption {
    readonly value: GradedThinkingEffort;
    readonly label: string;
}

export type ThinkingEffortNormalization =
    | { readonly ok: true; readonly value: ThinkingEffort | null }
    | { readonly ok: false; readonly message: string };

/**
 * null, 'off' or a graded effort; anything else is refused. Only the closed set
 * is checked here — a value the current model does not offer is stored anyway
 * (the model is free text and changes).
 */
export const normalizeThinkingEffort = (raw: unknown): ThinkingEffortNormalization => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: '思考等级必须是字符串或 null' };
    if (!isThinkingEffort(raw)) {
        return { ok: false, message: '思考等级必须是 null、off 或模型支持的档位' };
    }
    return { ok: true, value: raw };
};
