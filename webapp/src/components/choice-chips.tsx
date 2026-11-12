import { useCallback } from 'react';

export interface ChoiceOption<TValue> {
    value: TValue;
    label: string;
    // This one choice cannot be picked; the group's own `disabled` covers all of them
    disabled?: boolean;
}

interface ChoiceChipProps<TValue> {
    option: ChoiceOption<TValue>;
    checked: boolean;
    disabled: boolean;
    onSelect: (value: TValue) => void;
}

const ChoiceChip = <TValue,>({ option, checked, disabled, onSelect }: ChoiceChipProps<TValue>) => {
    const handleClick = useCallback(() => onSelect(option.value), [onSelect, option.value]);
    return (
        <button type="button" role="radio" aria-checked={checked} className="chip" disabled={disabled} onClick={handleClick}>
            {option.label}
        </button>
    );
};

interface ChoiceChipsProps<TValue> {
    // Accessible name of the group
    label: string;
    options: readonly ChoiceOption<TValue>[];
    // null when nothing is chosen yet
    selected: TValue | null;
    disabled?: boolean;
    onSelect: (value: TValue) => void;
}

/** Single choice as a row of chips; an "all" or "none" choice is just an option whose value is null */
export const ChoiceChips = <TValue,>({ label, options, selected, disabled = false, onSelect }: ChoiceChipsProps<TValue>) => (
    <div className="chips" role="radiogroup" aria-label={label}>
        {options.map((option) => (
            <ChoiceChip
                key={String(option.value)}
                option={option}
                checked={option.value === selected}
                disabled={disabled || option.disabled === true}
                onSelect={onSelect}
            />
        ))}
    </div>
);
