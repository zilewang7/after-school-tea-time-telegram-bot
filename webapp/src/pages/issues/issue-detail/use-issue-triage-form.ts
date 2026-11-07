import { useCallback, useMemo, useState } from 'react';
import { describeWriteFailure } from '../../../api';
import type { IssueDetail, IssuePatch, IssueStatus } from '../../../api';
import type { SaveStatus } from '../../../components/save-bar';
import { useApi } from '../../../context/panel-context';
import { useConfirm } from '../../../hooks/use-telegram-feedback';
import { issueStatusLabel, parseIssueStatus } from '../../../issues/issue-labels';
import { ISSUE_NOTE_MAX, normalizeIssueNote } from '../../../issues/issue-text';

/** Only the keys that differ from the issue as loaded; `status` null (unknown value) is never sent */
const changedIssueFieldsOf = (issue: IssueDetail, status: IssueStatus | null, note: string | null): IssuePatch => {
    const patch: IssuePatch = {};
    if (status !== null && status !== issue.status) patch.status = status;
    if (note !== issue.note) patch.note = note;
    return patch;
};

interface IssueTriageFormOptions {
    // Server state this form instance started from; the form is re-created when it changes
    issue: IssueDetail;
    onSaved: (issue: IssueDetail) => void;
}

/** The owner's status and note, saved as one PATCH of the changed keys; a status change is confirmed first */
export const useIssueTriageForm = ({ issue, onSaved }: IssueTriageFormOptions) => {
    const api = useApi();
    const confirm = useConfirm();
    const [status, setStatus] = useState<IssueStatus | null>(() => parseIssueStatus(issue.status));
    const [noteText, setNoteText] = useState(issue.note ?? '');
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    const noteValue = useMemo(() => normalizeIssueNote(noteText), [noteText]);
    const noteLength = noteValue?.length ?? 0;
    const patch = useMemo(() => changedIssueFieldsOf(issue, status, noteValue), [issue, status, noteValue]);
    const dirty = Object.keys(patch).length > 0;
    const noteTooLong = noteLength > ISSUE_NOTE_MAX;
    const valid = !noteTooLong;
    const saving = saveStatus.kind === 'saving';

    const save = useCallback(() => {
        if (!dirty || !valid || saving) return;
        const confirmed =
            patch.status === undefined
                ? Promise.resolve(true)
                : confirm(
                      `把 #${issue.id} 的状态从「${issueStatusLabel(issue.status)}」改为「${issueStatusLabel(patch.status)}」？`
                  );
        void confirmed.then((proceed) => {
            if (!proceed) return;
            setSaveStatus({ kind: 'saving' });
            void api.patchIssue(issue.id, patch).then((result) => {
                if (!result.ok) {
                    setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                    return;
                }
                setSaveStatus({ kind: 'idle' });
                onSaved(result.data.issue);
            });
        });
    }, [dirty, valid, saving, patch, confirm, issue.id, issue.status, api, onSaved]);

    return {
        status,
        setStatus,
        noteText,
        setNoteText,
        noteLength,
        noteTooLong,
        dirty,
        valid,
        saving,
        saveStatus,
        save,
    };
};
