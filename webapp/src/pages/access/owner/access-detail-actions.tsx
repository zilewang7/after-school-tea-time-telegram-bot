import type { AccessApplicationSummary } from '../../../api';
import { useAccessDetailActions } from './use-access-detail-actions';

interface AccessDetailActionsProps {
    application: AccessApplicationSummary;
    // Whether the applicant currently holds a grant; a rejected latest application can still have one
    accessActive: boolean;
    onApplicationChanged: (application: AccessApplicationSummary) => void;
    onAccessRevoked: () => void;
    onReload: () => void;
}

/** Resend a failed result, or revoke an approved user; hidden when neither applies */
export const AccessDetailActions = ({
    application,
    accessActive,
    onApplicationChanged,
    onAccessRevoked,
    onReload,
}: AccessDetailActionsProps) => {
    const actions = useAccessDetailActions({ application, onApplicationChanged, onAccessRevoked });
    const canResend = application.status !== 'pending' && application.deliveryStatus === 'failed';
    const canRevoke = accessActive;
    const savingAction = actions.status.kind === 'saving' ? actions.status.action : null;

    if (!canResend && !canRevoke && actions.successMessage === null) return null;

    return (
        <section className="section">
            <h2 className="section-title">操作</h2>
            {(canResend || canRevoke) && (
                <div className="button-row">
                    {canResend && (
                        <button
                            type="button"
                            className="button secondary"
                            disabled={actions.saving}
                            onClick={actions.resend}
                        >
                            {savingAction === 'resend' ? '重发中…' : '重发结果'}
                        </button>
                    )}
                    {canRevoke && (
                        <button
                            type="button"
                            className="button secondary"
                            disabled={actions.saving}
                            onClick={actions.revoke}
                        >
                            {savingAction === 'revoke' ? '取消中…' : '取消准入'}
                        </button>
                    )}
                </div>
            )}
            {actions.successMessage !== null && <p className="success-text">{actions.successMessage}</p>}
            {actions.status.kind === 'failed' && (
                <div className="save-failure">
                    <p className="error-text">{actions.status.view.message}</p>
                    {actions.status.view.suggestRefresh && (
                        <button type="button" className="button secondary" onClick={onReload}>
                            刷新
                        </button>
                    )}
                </div>
            )}
        </section>
    );
};
