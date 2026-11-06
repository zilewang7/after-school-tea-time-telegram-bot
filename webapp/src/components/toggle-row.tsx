import { useCallback } from 'react';
import type { ChangeEvent } from 'react';

interface ToggleRowProps {
    label: string;
    description: string | null;
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
}

export const ToggleRow = ({ label, description, checked, disabled, onChange }: ToggleRowProps) => {
    const handleChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
        [onChange]
    );
    return (
        <label className="toggle-row">
            <span className="toggle-text">
                <span>{label}</span>
                {description !== null && <span className="hint">{description}</span>}
            </span>
            <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={checked}
                disabled={disabled}
                onChange={handleChange}
            />
        </label>
    );
};
