/**
 * Thinking-level texts and option rules shared by the chat settings page and the
 * audit list. The server decides; these only mirror it for display.
 */
import type { ThinkingEffortView } from './api';

/** The field's label, also the audit key's label */
export const THINKING_EFFORT_LABEL = '思考等级';

/** Graded efforts, lowest first: the server's closed set */
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

/** Chinese label of every graded effort */
export const THINKING_EFFORT_LABELS: Readonly<Record<string, string>> = {
    none: '无',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
    ultra: '极限',
};

/** A toggle model's "thinking off" value, as chat_settings stores it */
export const THINKING_EFFORT_OFF = 'off';
export const THINKING_EFFORT_OFF_LABEL = '关闭思考';
/** The chip that stores null: the model's own default */
export const THINKING_EFFORT_DEFAULT_LABEL = '模型默认';
/** Shown when the current model offers neither graded efforts nor a toggle */
export const THINKING_EFFORT_UNSUPPORTED_HINT = '当前模型不支持思考档位';
/** What picking a level trades: one line, no page behaviour */
export const THINKING_EFFORT_TRADEOFF_HINT = '档位越高，思考越久、回复越慢。';

export const thinkingEffortLabel = (value: string): string => THINKING_EFFORT_LABELS[value] ?? value;

/** What the audit list shows for a stored value; null = the model default */
export const thinkingEffortAuditValue = (value: string | null): string => {
    if (value === null) return THINKING_EFFORT_DEFAULT_LABEL;
    if (value === THINKING_EFFORT_OFF) return THINKING_EFFORT_OFF_LABEL;
    return thinkingEffortLabel(value);
};

/** The model supports switching thinking off/on (the backend's catalog reasoning.toggle) */
export const thinkingEffortToggleSupported = (view: ThinkingEffortView): boolean => view.toggle;

/** The model offers neither graded efforts nor a toggle */
export const thinkingEffortUnsupportedOf = (view: ThinkingEffortView): boolean =>
    !view.supported && !view.toggle;

/** "模型默认（高）" / "模型默认（思考开）" / "模型默认（由模型决定）" / "模型默认" */
export const thinkingEffortDefaultLabelOf = (view: ThinkingEffortView): string => {
    if (view.effectiveDefault !== null) {
        return `${THINKING_EFFORT_DEFAULT_LABEL}（${thinkingEffortLabel(view.effectiveDefault)}）`;
    }
    if (!view.toggle) return THINKING_EFFORT_DEFAULT_LABEL;
    // A toggle model whose vendor default is unknown still has the switch
    if (view.enabledDefault === null) return `${THINKING_EFFORT_DEFAULT_LABEL}（由模型决定）`;
    return `${THINKING_EFFORT_DEFAULT_LABEL}（${view.enabledDefault ? '思考开' : '思考关'}）`;
};

/** Where the stored value comes from */
export const thinkingEffortSourceLabelOf = (source: ThinkingEffortView['source']): string =>
    source === 'chat' ? '本聊天设置' : '模型默认';

/** The stored choice as one line, without the source */
export const thinkingEffortChoiceLabelOf = (view: ThinkingEffortView): string => {
    if (view.value === null) return thinkingEffortDefaultLabelOf(view);
    if (view.value === THINKING_EFFORT_OFF) return THINKING_EFFORT_OFF_LABEL;
    return thinkingEffortLabel(view.value);
};

/** The "current" line of the field: the stored choice and where it comes from */
export const thinkingEffortSummaryOf = (view: ThinkingEffortView): string =>
    view.value === null
        ? thinkingEffortChoiceLabelOf(view)
        : `${thinkingEffortChoiceLabelOf(view)}（${thinkingEffortSourceLabelOf(view.source)}）`;

/** One chip of the field; a null value is the model default */
export interface ThinkingEffortChip {
    value: string | null;
    label: string;
    disabled: boolean;
}

/**
 * The chips to show: the model default first, then the model's graded efforts,
 * then the toggle's off, and last a stored value the current model no longer
 * offers (kept visible but not selectable, so it can be read and cleared).
 */
export const thinkingEffortChipsOf = (view: ThinkingEffortView): readonly ThinkingEffortChip[] => {
    const chips: ThinkingEffortChip[] = [
        { value: null, label: thinkingEffortDefaultLabelOf(view), disabled: false },
    ];
    for (const option of view.options) {
        chips.push({
            value: option.value,
            label: thinkingEffortLabel(option.value),
            disabled: !view.supported,
        });
    }
    if (thinkingEffortToggleSupported(view)) {
        chips.push({ value: THINKING_EFFORT_OFF, label: THINKING_EFFORT_OFF_LABEL, disabled: false });
    }
    if (view.value !== null && !chips.some((chip) => chip.value === view.value)) {
        chips.push({
            value: view.value,
            label: `${thinkingEffortLabel(view.value)}（当前模型不支持）`,
            disabled: true,
        });
    }
    return chips;
};

/** What is wrong with the stored value on the current model; null = it applies */
export const thinkingEffortIssueOf = (view: ThinkingEffortView): string | null => {
    if (view.value === null) return null;
    if (view.value === THINKING_EFFORT_OFF) {
        return thinkingEffortToggleSupported(view) ? null : '当前模型不支持关闭思考';
    }
    const offered = view.supported && view.options.some((option) => option.value === view.value);
    return offered ? null : `当前模型不支持「${thinkingEffortLabel(view.value)}」`;
};
