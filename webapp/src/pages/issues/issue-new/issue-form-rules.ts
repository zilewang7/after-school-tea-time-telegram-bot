import type { IssueCreateRequest } from '../../../api';
import type { IssueDraft } from '../../../issues/issue-draft';
import { ISSUE_BODY_MAX, ISSUE_TITLE_MAX, issueTextLength } from '../../../issues/issue-text';

/** Names of the required fields still empty, in form order */
export const missingIssueFieldsOf = (draft: IssueDraft): string[] => [
    ...(draft.kind === null ? ['类型'] : []),
    ...(draft.title.trim() === '' ? ['标题'] : []),
    ...(draft.body.trim() === '' ? ['正文'] : []),
];

/**
 * The POST body when the draft can be filed (same checks as the server:
 * required fields, trimmed lengths), else null. Severity is left out when not chosen.
 */
export const issueRequestOf = (chatId: number, draft: IssueDraft): IssueCreateRequest | null => {
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (draft.kind === null || title === '' || body === '') return null;
    if (issueTextLength(title) > ISSUE_TITLE_MAX || issueTextLength(body) > ISSUE_BODY_MAX) return null;
    const request: IssueCreateRequest = { chatId, kind: draft.kind, title, body };
    return draft.severity === null ? request : { ...request, severity: draft.severity };
};
