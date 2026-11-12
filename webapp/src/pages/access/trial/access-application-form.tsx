import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { AccessApplicationSummary } from '../../../api';
import { LengthCounter } from '../../../components/length-counter';
import { SaveBar } from '../../../components/save-bar';
import { useVerticalSwipeLock } from '../../../hooks/use-telegram-guards';
import { ACCESS_IDENTITY_MAX, ACCESS_PURPOSE_MAX } from '../access-form-rules';
import { useAccessApplicationForm } from './use-access-application-form';

interface AccessApplicationFormProps {
    onCreated: (application: AccessApplicationSummary) => void;
}

/** 「你是谁」/「你要做什么」, submitted with the MainButton */
export const AccessApplicationForm = ({ onCreated }: AccessApplicationFormProps) => {
    const form = useAccessApplicationForm({ onCreated });
    const { setIdentity, setPurpose } = form;
    const [editing, setEditing] = useState(false);
    // Scrolling inside a text must not swipe the panel closed
    useVerticalSwipeLock(editing);
    const disabled = form.saving;

    const handleIdentityInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setIdentity(event.target.value),
        [setIdentity]
    );
    const handlePurposeInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setPurpose(event.target.value),
        [setPurpose]
    );
    const handleFocus = useCallback(() => setEditing(true), []);
    const handleBlur = useCallback(() => setEditing(false), []);

    return (
        <section className="section">
            <h2 className="section-title">申请完整功能</h2>
            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="access-identity" className="field-label">
                        你是谁
                    </label>
                    <LengthCounter length={form.identityLength} max={ACCESS_IDENTITY_MAX} />
                </div>
                <textarea
                    id="access-identity"
                    className="field issue-text-input"
                    value={form.identity}
                    disabled={disabled}
                    rows={3}
                    placeholder="你的身份、和机主的关系"
                    onChange={handleIdentityInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                />
                {form.identityTooLong && <p className="error-text">超过 {ACCESS_IDENTITY_MAX} 字，无法提交</p>}
            </div>
            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="access-purpose" className="field-label">
                        你要做什么
                    </label>
                    <LengthCounter length={form.purposeLength} max={ACCESS_PURPOSE_MAX} />
                </div>
                <textarea
                    id="access-purpose"
                    className="field issue-text-input"
                    value={form.purpose}
                    disabled={disabled}
                    rows={5}
                    placeholder="申请完整功能的用途，例如想用 gpt 生图做海报"
                    onChange={handlePurposeInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                />
                {form.purposeTooLong && <p className="error-text">超过 {ACCESS_PURPOSE_MAX} 字，无法提交</p>}
            </div>
            <SaveBar
                writable
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={false}
                savedMessage=""
                pendingHint={form.pendingHint}
                actionLabel="提交"
                onSave={form.submit}
                onRefresh={null}
            />
        </section>
    );
};
