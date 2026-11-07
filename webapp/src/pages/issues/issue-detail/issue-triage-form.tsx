import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { IssueDetail } from '../../../api';
import { ChoiceChips } from '../../../components/choice-chips';
import { LengthCounter } from '../../../components/length-counter';
import { SaveBar } from '../../../components/save-bar';
import { useVerticalSwipeLock } from '../../../hooks/use-telegram-guards';
import { ISSUE_STATUS_OPTIONS } from '../../../issues/issue-labels';
import { ISSUE_NOTE_MAX } from '../../../issues/issue-text';
import { useIssueTriageForm } from './use-issue-triage-form';

interface IssueTriageFormProps {
    issue: IssueDetail;
    justSaved: boolean;
    onSaved: (issue: IssueDetail) => void;
    onReload: () => void;
}

/** Owner only: status and handling note, saved with the MainButton */
export const IssueTriageForm = ({ issue, justSaved, onSaved, onReload }: IssueTriageFormProps) => {
    const form = useIssueTriageForm({ issue, onSaved });
    const { setNoteText } = form;
    const [editingNote, setEditingNote] = useState(false);
    // Scrolling inside the note must not swipe the panel closed
    useVerticalSwipeLock(editingNote);

    const handleNoteInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setNoteText(event.target.value),
        [setNoteText]
    );
    const handleNoteFocus = useCallback(() => setEditingNote(true), []);
    const handleNoteBlur = useCallback(() => setEditingNote(false), []);

    return (
        <section className="section">
            <h2 className="section-title">处理</h2>
            <div className="field-group">
                <span className="field-label">状态</span>
                <ChoiceChips
                    label="状态"
                    options={ISSUE_STATUS_OPTIONS}
                    selected={form.status}
                    disabled={form.saving}
                    onSelect={form.setStatus}
                />
            </div>
            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="issue-note" className="field-label">
                        处理备注
                    </label>
                    <LengthCounter length={form.noteLength} max={ISSUE_NOTE_MAX} />
                </div>
                <textarea
                    id="issue-note"
                    className="field issue-text-input"
                    value={form.noteText}
                    disabled={form.saving}
                    rows={4}
                    placeholder="处理说明，能看到这个 issue 的人都能看到（可留空）"
                    onChange={handleNoteInput}
                    onFocus={handleNoteFocus}
                    onBlur={handleNoteBlur}
                />
                {form.noteTooLong && <p className="error-text">超过 {ISSUE_NOTE_MAX} 字，无法保存</p>}
            </div>
            <SaveBar
                writable
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={justSaved}
                savedMessage="已保存"
                pendingHint={null}
                onSave={form.save}
                onRefresh={onReload}
            />
        </section>
    );
};
