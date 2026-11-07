import type { ToolGroupEntry, ToolGroupKey } from '../../api';
import { ToolGroupRow } from './tool-group-row';

interface ToolListProps {
    groups: readonly ToolGroupEntry[];
    // The chat is not locked, or the viewer is the owner
    canToggle: boolean;
    isOwner: boolean;
    savingKey: ToolGroupKey | null;
    onChange: (group: ToolGroupEntry, next: boolean) => void;
    onReset: (group: ToolGroupEntry) => void;
}

/** One row per tool group: its tools, why it is off, and the panel switch */
export const ToolList = ({ groups, canToggle, isOwner, savingKey, onChange, onReset }: ToolListProps) => {
    if (groups.length === 0) return <p className="placeholder">没有工具</p>;
    return (
        <ul className="list">
            {groups.map((group) => (
                <ToolGroupRow
                    key={group.key}
                    group={group}
                    canToggle={canToggle}
                    isOwner={isOwner}
                    saving={savingKey === group.key}
                    disabled={savingKey !== null}
                    onChange={onChange}
                    onReset={onReset}
                />
            ))}
        </ul>
    );
};
