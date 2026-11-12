import { ToggleRow } from '../../components/toggle-row';
import { GEMINI_PRIORITY_HELP, GEMINI_PRIORITY_LABEL, GLOBAL_GEMINI_PRIORITY_SCOPE_HINT } from '../../gemini-priority';

interface GlobalPriorityFieldProps {
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
}

/** The global Priority PayGo switch; saved with the rest of the page by its single SaveBar */
export const GlobalPriorityField = ({ checked, disabled, onChange }: GlobalPriorityFieldProps) => (
    <div className="field-group">
        <ToggleRow
            label={GEMINI_PRIORITY_LABEL}
            description={GEMINI_PRIORITY_HELP}
            checked={checked}
            disabled={disabled}
            onChange={onChange}
        />
        <p className="hint">{GLOBAL_GEMINI_PRIORITY_SCOPE_HINT}</p>
    </div>
);
