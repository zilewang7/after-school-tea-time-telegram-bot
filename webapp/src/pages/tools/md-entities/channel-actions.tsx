export interface ChannelAction {
    id: string;
    label: string;
    /** One line under the button saying what the clipboard will carry */
    hint: string;
    recommended: boolean;
    disabled: boolean;
    onSelect: () => void;
}

interface ChannelActionsProps {
    actions: readonly ChannelAction[];
}

/** The copy buttons: the platform-recommended channel is highlighted */
export const ChannelActions = ({ actions }: ChannelActionsProps) => (
    <div className="tools-actions">
        {actions.map((action) => (
            <div className="tools-action" key={action.id}>
                <button
                    type="button"
                    className={
                        action.recommended
                            ? 'button primary tools-action-button'
                            : 'button secondary tools-action-button'
                    }
                    disabled={action.disabled}
                    onClick={action.onSelect}
                >
                    {action.label}
                    {action.recommended && <span className="tools-action-badge">推荐</span>}
                </button>
                <span className="hint">{action.hint}</span>
            </div>
        ))}
    </div>
);
