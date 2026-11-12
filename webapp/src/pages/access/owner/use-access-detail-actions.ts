import { useCallback, useState } from 'react';
import { describeAccessReviewFailure, describeAccessRevokeFailure } from '../../../api';
import type { AccessApplicationSummary, WriteFailureView } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useConfirm, useSuccessHaptic } from '../../../hooks/use-telegram-feedback';

type AccessAction = 'resend' | 'revoke';

type ActionSaveStatus =
    | { kind: 'idle' }
    | { kind: 'saving'; action: AccessAction }
    | { kind: 'failed'; view: WriteFailureView };

interface AccessDetailActionsOptions {
    application: AccessApplicationSummary;
    onApplicationChanged: (application: AccessApplicationSummary) => void;
    onAccessRevoked: () => void;
}

const revokeQuestionOf = (application: AccessApplicationSummary): string =>
    `取消 ${application.userName} 的完整功能准入？该用户会回到体验用户。`;

/** Resend a failed delivery, or revoke an approved user's access */
export const useAccessDetailActions = ({
    application,
    onApplicationChanged,
    onAccessRevoked,
}: AccessDetailActionsOptions) => {
    const api = useApi();
    const confirm = useConfirm();
    const notifySaved = useSuccessHaptic();
    const [status, setStatus] = useState<ActionSaveStatus>({ kind: 'idle' });
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    const saving = status.kind === 'saving';

    const resend = useCallback(() => {
        if (saving) return;
        setStatus({ kind: 'saving', action: 'resend' });
        setSuccessMessage(null);
        void api.resendAccessApplication(application.id).then((result) => {
            if (!result.ok) {
                setStatus({ kind: 'failed', view: describeAccessReviewFailure(result.failure) });
                return;
            }
            setStatus({ kind: 'idle' });
            setSuccessMessage('已重发结果');
            notifySaved();
            onApplicationChanged(result.data.application);
        });
    }, [saving, api, application.id, notifySaved, onApplicationChanged]);

    const revoke = useCallback(() => {
        if (saving) return;
        void confirm(revokeQuestionOf(application)).then((proceed) => {
            if (!proceed) return;
            setStatus({ kind: 'saving', action: 'revoke' });
            setSuccessMessage(null);
            void api.revokeUserAccess(application.userId).then((result) => {
                if (!result.ok) {
                    setStatus({ kind: 'failed', view: describeAccessRevokeFailure(result.failure) });
                    return;
                }
                setStatus({ kind: 'idle' });
                // revoked false = the row was already gone (e.g. revoked from another session)
                setSuccessMessage(result.data.revoked ? '已取消该用户的准入' : '该用户当前没有准入');
                notifySaved();
                onAccessRevoked();
            });
        });
    }, [saving, confirm, application, api, notifySaved, onAccessRevoked]);

    return { status, saving, successMessage, resend, revoke };
};
