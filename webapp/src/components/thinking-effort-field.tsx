import { useMemo } from 'react';
import type { ThinkingEffortView } from '../api';
import {
    THINKING_EFFORT_LABEL,
    THINKING_EFFORT_TRADEOFF_HINT,
    THINKING_EFFORT_UNSUPPORTED_HINT,
    thinkingEffortChipsOf,
    thinkingEffortIssueOf,
    thinkingEffortSummaryOf,
    thinkingEffortUnsupportedOf,
} from '../thinking-effort';
import { ChoiceChips } from './choice-chips';

interface ThinkingEffortFieldProps {
    // The server's view of the chat's level and the effective model's efforts
    view: ThinkingEffortView;
    // The draft: null = model default, 'off' = thinking off, else a graded effort
    choice: string | null;
    // The form is read-only or saving, or the user is a trial user
    disabled: boolean;
    onChange: (choice: string | null) => void;
}

/** The chat's thinking level (design §5); the graded options are the current model's own */
export const ThinkingEffortField = ({ view, choice, disabled, onChange }: ThinkingEffortFieldProps) => {
    const chips = useMemo(() => thinkingEffortChipsOf(view), [view]);
    const issue = useMemo(() => thinkingEffortIssueOf(view), [view]);
    const unsupported = thinkingEffortUnsupportedOf(view);

    return (
        <div className="field-group">
            <span className="field-label">{THINKING_EFFORT_LABEL}</span>
            <ChoiceChips
                label={THINKING_EFFORT_LABEL}
                options={chips}
                selected={choice}
                disabled={disabled}
                onSelect={onChange}
            />
            <p className="hint">当前：{thinkingEffortSummaryOf(view)}</p>
            <p className="hint">{THINKING_EFFORT_TRADEOFF_HINT}</p>
            {unsupported && <p className="hint">{THINKING_EFFORT_UNSUPPORTED_HINT}</p>}
            {issue !== null && <p className="notice warning">{issue}</p>}
        </div>
    );
};
