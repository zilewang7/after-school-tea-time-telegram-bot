import type { WriteFailureView } from '../api';
import { EXPIRED_WRITE_NOTICE, useInitDataExpired } from '../hooks/use-init-data-expired';
import { useSaveMainButton } from '../hooks/use-save-main-button';
import { useClosingConfirmation } from '../hooks/use-telegram-guards';

export type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; view: WriteFailureView };

const DEFAULT_ACTION_LABEL = '保存';

interface SaveBarProps {
    writable: boolean;
    dirty: boolean;
    valid: boolean;
    status: SaveStatus;
    // Set by the page after a successful save; the form itself is re-created from the new server state
    justSaved: boolean;
    savedMessage: string;
    // What saving will do, shown while there are unsaved changes
    pendingHint: string | null;
    // Button and MainButton text; 「保存」 unless given
    actionLabel?: string;
    onSave: () => void;
    // Re-reads the server state after a failure that may have saved anyway; null offers no refresh button
    onRefresh: (() => void) | null;
}

/**
 * In-page save button mirrored by Telegram's MainButton, with the initData age notice and save outcome.
 * While there are unsaved changes, closing the panel asks for confirmation first.
 */
export const SaveBar = ({
    writable,
    dirty,
    valid,
    status,
    justSaved,
    savedMessage,
    pendingHint,
    actionLabel = DEFAULT_ACTION_LABEL,
    onSave,
    onRefresh,
}: SaveBarProps) => {
    const expired = useInitDataExpired();
    const saving = status.kind === 'saving';
    useSaveMainButton({ writable, dirty, valid, saving, expired, label: actionLabel, onSave });
    useClosingConfirmation(writable && dirty);

    if (!writable) return null;
    return (
        <div className="save-bar">
            {expired && <p className="notice warning">{EXPIRED_WRITE_NOTICE}</p>}
            <button
                type="button"
                className="button primary"
                disabled={!dirty || !valid || saving || expired}
                onClick={onSave}
            >
                {saving ? `${actionLabel}中…` : actionLabel}
            </button>
            {status.kind === 'failed' && (
                <div className="save-failure">
                    <p className="error-text">{status.view.message}</p>
                    {status.view.suggestRefresh && onRefresh !== null && (
                        <button type="button" className="button secondary" onClick={onRefresh}>
                            刷新
                        </button>
                    )}
                </div>
            )}
            {status.kind === 'idle' && dirty && pendingHint !== null && <p className="hint">{pendingHint}</p>}
            {status.kind === 'idle' && !dirty && justSaved && <p className="success-text">{savedMessage}</p>}
        </div>
    );
};
