import { useMemo } from 'react';
import { ChoiceChips } from '../../components/choice-chips';
import {
    chatGeminiPriorityOptionsOf,
    GEMINI_PRIORITY_APPLIES_HINT,
    GEMINI_PRIORITY_HELP,
    GEMINI_PRIORITY_LABEL,
    GEMINI_PRIORITY_NOT_ALLOWED_HINT,
    GEMINI_PRIORITY_OWNER_ONLY_HINT,
    onOffLabel,
} from '../../gemini-priority';
import type { ChatGeminiPriorityState } from '../../gemini-priority';

interface GeminiPriorityFieldProps {
    // The draft; null = follow the global switch
    choice: boolean | null;
    // The saved choice the form started from
    savedChoice: boolean | null;
    state: ChatGeminiPriorityState;
    isOwner: boolean;
    // The form is read-only or saving
    disabled: boolean;
    onChange: (choice: boolean | null) => void;
}

/** The chat's three-state Priority PayGo choice (design §8.5); only the owner may change it (D4) */
export const GeminiPriorityField = ({
    choice,
    savedChoice,
    state,
    isOwner,
    disabled,
    onChange,
}: GeminiPriorityFieldProps) => {
    const { globalOn, canEnable, effective } = state;
    const options = useMemo(
        () => chatGeminiPriorityOptionsOf(globalOn, canEnable, savedChoice),
        [globalOn, canEnable, savedChoice]
    );
    // A stored "on" stays in the row while the global switch is off, but does not apply
    const onWithoutEffect = choice === true && !canEnable;

    return (
        <div className="field-group">
            <span className="field-label">{GEMINI_PRIORITY_LABEL}</span>
            <ChoiceChips
                label={GEMINI_PRIORITY_LABEL}
                options={options}
                selected={choice}
                disabled={disabled || !isOwner}
                onSelect={onChange}
            />
            <p className="hint">{GEMINI_PRIORITY_HELP}</p>
            <p className="hint">当前生效：{onOffLabel(effective)}</p>
            <p className="hint">{GEMINI_PRIORITY_APPLIES_HINT}</p>
            {onWithoutEffect && (
                <p className="notice warning">「开」当前不生效：{GEMINI_PRIORITY_NOT_ALLOWED_HINT}</p>
            )}
            {!isOwner && <p className="hint">{GEMINI_PRIORITY_OWNER_ONLY_HINT}</p>}
            {isOwner && !canEnable && !onWithoutEffect && <p className="hint">{GEMINI_PRIORITY_NOT_ALLOWED_HINT}</p>}
        </div>
    );
};
