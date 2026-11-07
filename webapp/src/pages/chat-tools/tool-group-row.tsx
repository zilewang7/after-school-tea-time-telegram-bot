import { useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { ToolGroupEntry } from '../../api';
import { toolGroupHintOf, toolGroupLabelOf } from '../../tool-groups';

interface ToolGroupRowProps {
    group: ToolGroupEntry;
    // Members may flip every switch except sms; the owner may flip all
    canToggle: boolean;
    isOwner: boolean;
    saving: boolean;
    // Another group's switch is being saved
    disabled: boolean;
    onChange: (group: ToolGroupEntry, next: boolean) => void;
    onReset: (group: ToolGroupEntry) => void;
}

/**
 * The switch shows the stored setting: the panel override, or the env state when
 * there is none. Flipping it back to the env state drops the override instead of
 * storing a redundant value.
 */
export const ToolGroupRow = ({
    group,
    canToggle,
    isOwner,
    saving,
    disabled,
    onChange,
    onReset,
}: ToolGroupRowProps) => {
    const checked = group.override ?? group.defaultEnabled;
    const smsOwnerOnly = group.key === 'sms' && !isOwner;
    const switchDisabled = disabled || saving || group.blocked || smsOwnerOnly;
    const handleChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => onChange(group, event.target.checked),
        [group, onChange]
    );
    const handleReset = useCallback(() => onReset(group), [group, onReset]);
    const hint = toolGroupHintOf(group.key);

    return (
        <li className="tool-group-row">
            <label className="tool-group-head">
                <span className="toggle-text">
                    <span className="tool-group-title">{toolGroupLabelOf(group.key)}</span>
                    <span className="hint">{group.tools.join(' · ')}</span>
                </span>
                {canToggle ? (
                    <input
                        type="checkbox"
                        role="switch"
                        className="switch"
                        checked={checked}
                        disabled={switchDisabled}
                        onChange={handleChange}
                    />
                ) : (
                    <span className={group.enabled ? 'badge success' : 'badge'}>{group.enabled ? '开' : '关'}</span>
                )}
            </label>
            {hint !== null && <p className="hint">{hint}</p>}
            {group.reason !== null && <p className="hint tool-group-reason">{group.reason}</p>}
            {group.override !== null && (
                <p className="hint tool-group-override">
                    面板已{group.override ? '开启' : '关闭'}
                    {canToggle && (
                        <button type="button" className="link-action" disabled={disabled || saving} onClick={handleReset}>
                            恢复跟随环境
                        </button>
                    )}
                </p>
            )}
            {smsOwnerOnly && <p className="hint">短信只有机主可以开关</p>}
            {saving && <p className="hint">保存中…</p>}
        </li>
    );
};
