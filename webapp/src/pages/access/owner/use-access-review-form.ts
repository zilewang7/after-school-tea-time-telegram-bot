import { useCallback, useMemo, useState } from 'react';
import { describeAccessReviewFailure } from '../../../api';
import type { AccessApplicationPatch, AccessApplicationSummary, WriteFailureView } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useConfirm, useSuccessHaptic } from '../../../hooks/use-telegram-feedback';
import { ACCESS_COMMENT_MAX, normalizeAccessComment } from '../access-form-rules';

export type AccessReviewAction = 'approve' | 'reject';

type ReviewSaveStatus =
    | { kind: 'idle' }
    | { kind: 'saving'; action: AccessReviewAction }
    | { kind: 'failed'; view: WriteFailureView };

interface AccessReviewFormOptions {
    applicationId: number;
    onReviewed: (application: AccessApplicationSummary) => void;
}

const confirmQuestionOf = (action: AccessReviewAction, applicationId: number): string =>
    action === 'approve' ? `通过 #${applicationId} 的准入申请？` : `拒绝 #${applicationId} 的准入申请？`;

/** The optional comment and the approve / reject PATCH; a decision is confirmed first */
export const useAccessReviewForm = ({ applicationId, onReviewed }: AccessReviewFormOptions) => {
    const api = useApi();
    const confirm = useConfirm();
    const notifySaved = useSuccessHaptic();
    const [commentText, setCommentText] = useState('');
    const [saveStatus, setSaveStatus] = useState<ReviewSaveStatus>({ kind: 'idle' });

    const comment = useMemo(() => normalizeAccessComment(commentText), [commentText]);
    const commentLength = comment?.length ?? 0;
    const commentTooLong = commentLength > ACCESS_COMMENT_MAX;
    const saving = saveStatus.kind === 'saving';

    const submit = useCallback(
        (action: AccessReviewAction) => {
            if (saving || commentTooLong) return;
            void confirm(confirmQuestionOf(action, applicationId)).then((proceed) => {
                if (!proceed) return;
                setSaveStatus({ kind: 'saving', action });
                const patch: AccessApplicationPatch = comment === null ? { action } : { action, comment };
                void api.reviewAccessApplication(applicationId, patch).then((result) => {
                    if (!result.ok) {
                        setSaveStatus({ kind: 'failed', view: describeAccessReviewFailure(result.failure) });
                        return;
                    }
                    setSaveStatus({ kind: 'idle' });
                    notifySaved();
                    onReviewed(result.data.application);
                });
            });
        },
        [saving, commentTooLong, confirm, applicationId, comment, api, notifySaved, onReviewed]
    );

    return { commentText, setCommentText, commentLength, commentTooLong, saving, saveStatus, submit };
};
