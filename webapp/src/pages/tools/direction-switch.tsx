import { useCallback } from 'react';

export type ToolDirection = 'forward' | 'reverse';

interface DirectionOption {
    value: ToolDirection;
    label: string;
}

const OPTIONS: readonly DirectionOption[] = [
    { value: 'forward', label: 'Markdown → Telegram' },
    { value: 'reverse', label: 'Telegram → Markdown' },
];

interface DirectionButtonProps {
    option: DirectionOption;
    selected: boolean;
    onSelect: (value: ToolDirection) => void;
}

const DirectionButton = ({ option, selected, onSelect }: DirectionButtonProps) => {
    const handleClick = useCallback(() => onSelect(option.value), [onSelect, option.value]);
    return (
        <button type="button" role="tab" aria-selected={selected} className="segment" onClick={handleClick}>
            {option.label}
        </button>
    );
};

interface DirectionSwitchProps {
    value: ToolDirection;
    onChange: (value: ToolDirection) => void;
}

/** The two conversion directions, as a Telegram-style segmented control */
export const DirectionSwitch = ({ value, onChange }: DirectionSwitchProps) => (
    <div className="segment-control" role="tablist" aria-label="转换方向">
        {OPTIONS.map((option) => (
            <DirectionButton key={option.value} option={option} selected={option.value === value} onSelect={onChange} />
        ))}
    </div>
);
