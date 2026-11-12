import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { AccessApplicationSummary } from '../../../api';
import { LengthCounter } from '../../../components/length-counter';
import { useVerticalSwipeLock } from '../../../hooks/use-telegram-guards';
import { ACCESS_COMMENT_MAX } from '../access-form-rules';
import { useAccessReviewForm } from './use-access-review-form';

interface AccessReviewFormProps {
    applicationId: number;
    onReviewed: (application: AccessApplicationSummary) => void;
    onReload: () => void;
}

/** Approve or reject with an optional comment; the outcome is delivered to the applicant's chat */
export const AccessReviewForm = ({ applicationId, onReviewed, onReload }: AccessReviewFormProps) => {
    const form = useAccessReviewForm({ applicationId, onReviewed });
    const { setCommentText, submit } = form;
    const [editing, setEditing] = useState(false);
    // Scrolling inside the comment must not swipe the panel closed
    useVerticalSwipeLock(editing);

    const handleCommentInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setCommentText(event.target.value),
        [setCommentText]
    );
    const handleFocus = useCallback(() => setEditing(true), []);
    const handleBlur = useCallback(() => setEditing(false), []);
    const handleApprove = useCallback(() => submit('approve'), [submit]);
    const handleReject = useCallback(() => submit('reject'), [submit]);

    const savingAction = form.saveStatus.kind === 'saving' ? form.saveStatus.action : null;
    const disabled = form.saving || form.commentTooLong;

    return (
        <section className="section">
            <h2 className="section-title">审核</h2>
            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="access-comment" className="field-label">
                        机主留言 <span className="hint">可选，会发给申请人</span>
                    </label>
                    <LengthCounter length={form.commentLength} max={ACCESS_COMMENT_MAX} />
                </div>
                <textarea
                    id="access-comment"
                    className="field issue-text-input"
                    value={form.commentText}
                    disabled={form.saving}
                    rows={4}
                    placeholder="拒绝时建议说明原因，申请人可补充信息后重新申请"
                    onChange={handleCommentInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                />
                {form.commentTooLong && <p className="error-text">超过 {ACCESS_COMMENT_MAX} 字，无法提交</p>}
            </div>
            <div className="button-row">
                <button type="button" className="button primary" disabled={disabled} onClick={handleApprove}>
                    {savingAction === 'approve' ? '提交中…' : '通过'}
                </button>
                <button type="button" className="button secondary" disabled={disabled} onClick={handleReject}>
                    {savingAction === 'reject' ? '提交中…' : '拒绝'}
                </button>
            </div>
            {form.saveStatus.kind === 'failed' && (
                <div className="save-failure">
                    <p className="error-text">{form.saveStatus.view.message}</p>
                    {form.saveStatus.view.suggestRefresh && (
                        <button type="button" className="button secondary" onClick={onReload}>
                            刷新
                        </button>
                    )}
                </div>
            )}
        </section>
    );
};
