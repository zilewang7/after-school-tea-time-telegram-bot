import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeIssueCreateFailure } from '../../../api';
import type { IssueDetail, IssueKind, IssueSeverity } from '../../../api';
import type { SaveStatus } from '../../../components/save-bar';
import { useApi } from '../../../context/panel-context';
import { clearIssueDraft, isBlankIssueDraft, restoreIssueDraft, storeIssueDraft } from '../../../issues/issue-draft';
import type { IssueDraft, IssueDraftStart } from '../../../issues/issue-draft';
import { issueTextLength } from '../../../issues/issue-text';
import { issueRequestOf, missingIssueFieldsOf } from './issue-form-rules';

const DRAFT_DEBOUNCE_MS = 500;

interface IssueFormOptions {
    chatId: number;
    onCreated: (issue: IssueDetail) => void;
}

export const useIssueForm = ({ chatId, onCreated }: IssueFormOptions) => {
    const api = useApi();
    const [start] = useState<IssueDraftStart>(() => restoreIssueDraft(chatId));
    const [kind, setKind] = useState<IssueKind | null>(start.draft.kind);
    const [severity, setSeverity] = useState<IssueSeverity | null>(start.draft.severity);
    const [title, setTitle] = useState(start.draft.title);
    const [body, setBody] = useState(start.draft.body);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
    // Set once the issue exists, so a debounce still pending cannot write the draft back
    const filedRef = useRef(false);

    const draft = useMemo<IssueDraft>(() => ({ kind, severity, title, body }), [kind, severity, title, body]);
    const latestDraftRef = useRef(draft);

    // Debounced local draft; kept on every failure (401 included), dropped once filed
    useEffect(() => {
        latestDraftRef.current = draft;
        const timer = window.setTimeout(() => {
            if (!filedRef.current) storeIssueDraft(chatId, draft);
        }, DRAFT_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [chatId, draft]);

    // Leaving within the debounce (e.g. Back right after typing) still keeps the last words
    useEffect(
        () => () => {
            if (!filedRef.current) storeIssueDraft(chatId, latestDraftRef.current);
        },
        [chatId]
    );

    const request = useMemo(() => issueRequestOf(chatId, draft), [chatId, draft]);
    const missingFields = useMemo(() => missingIssueFieldsOf(draft), [draft]);
    const saving = saveStatus.kind === 'saving';

    const submit = useCallback(() => {
        if (request === null || saving) return;
        setSaveStatus({ kind: 'saving' });
        void api.createIssue(request).then((result) => {
            if (!result.ok) {
                setSaveStatus({ kind: 'failed', view: describeIssueCreateFailure(result.failure) });
                return;
            }
            filedRef.current = true;
            clearIssueDraft(chatId);
            onCreated(result.data.issue);
        });
    }, [request, saving, api, chatId, onCreated]);

    return {
        kind,
        setKind,
        severity,
        setSeverity,
        title,
        setTitle,
        titleLength: issueTextLength(title),
        body,
        setBody,
        bodyLength: issueTextLength(body),
        restoredFromDraft: start.restoredFromDraft,
        missingHint: missingFields.length === 0 ? null : `还需填写：${missingFields.join('、')}`,
        dirty: !isBlankIssueDraft(draft),
        valid: request !== null,
        saving,
        saveStatus,
        submit,
    };
};
