import { useCallback } from 'react';
import type { ChangeEvent } from 'react';
import { match } from 'ts-pattern';
import type { ModelDraft } from '../model-draft';

// Option values are prefixed so a model id can never collide with the special options
const UNSET_OPTION = 'special:unset';
const CUSTOM_OPTION = 'special:custom';
const MENU_OPTION_PREFIX = 'model:';

const optionValueOf = (draft: ModelDraft): string =>
    match(draft)
        .with({ kind: 'unset' }, () => UNSET_OPTION)
        .with({ kind: 'menu' }, ({ id }) => `${MENU_OPTION_PREFIX}${id}`)
        .with({ kind: 'custom' }, () => CUSTOM_OPTION)
        .exhaustive();

// Switching to 「自定义」 starts from the id that was selected, which makes small edits easy
const customTextOf = (draft: ModelDraft): string =>
    match(draft)
        .with({ kind: 'unset' }, () => '')
        .with({ kind: 'menu' }, ({ id }) => id)
        .with({ kind: 'custom' }, ({ text }) => text)
        .exhaustive();

interface ModelPickerProps {
    inputId: string;
    models: readonly string[];
    draft: ModelDraft;
    // Label of the option that stores null; null hides that option
    unsetLabel: string | null;
    error: string | null;
    disabled: boolean;
    onChange: (draft: ModelDraft) => void;
}

/** Menu models in a select, plus a free-text input for any other model id */
export const ModelPicker = ({ inputId, models, draft, unsetLabel, error, disabled, onChange }: ModelPickerProps) => {
    const handleSelect = useCallback(
        (event: ChangeEvent<HTMLSelectElement>) => {
            const optionValue = event.target.value;
            if (optionValue === UNSET_OPTION) onChange({ kind: 'unset' });
            else if (optionValue === CUSTOM_OPTION) onChange({ kind: 'custom', text: customTextOf(draft) });
            else onChange({ kind: 'menu', id: optionValue.slice(MENU_OPTION_PREFIX.length) });
        },
        [draft, onChange]
    );

    const handleCustomInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => onChange({ kind: 'custom', text: event.target.value }),
        [onChange]
    );

    const customModelId = draft.kind === 'custom' ? draft.text.trim() : '';
    const showOutsideMenuHint = customModelId !== '' && !models.includes(customModelId);

    return (
        <div className="model-picker">
            <select id={inputId} className="field" value={optionValueOf(draft)} disabled={disabled} onChange={handleSelect}>
                {unsetLabel !== null && <option value={UNSET_OPTION}>{unsetLabel}</option>}
                {models.map((modelId) => (
                    <option key={modelId} value={`${MENU_OPTION_PREFIX}${modelId}`}>
                        {modelId}
                    </option>
                ))}
                <option value={CUSTOM_OPTION}>自定义…</option>
            </select>
            {draft.kind === 'custom' && (
                <input
                    className="field"
                    type="text"
                    value={draft.text}
                    disabled={disabled}
                    placeholder="填写模型 id"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="自定义模型 id"
                    onChange={handleCustomInput}
                />
            )}
            {showOutsideMenuHint && <p className="hint">不在菜单里</p>}
            {error !== null && <p className="error-text">{error}</p>}
        </div>
    );
};
