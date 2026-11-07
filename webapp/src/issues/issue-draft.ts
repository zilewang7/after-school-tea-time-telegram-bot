// The new-issue form's local draft (draft:issue:<chatId>), so closing the panel does not lose typing.

import type { IssueKind, IssueSeverity } from '../api';
import { readStorage, removeStorage, writeStorage } from '../storage';
import { parseIssueKind, parseIssueSeverity } from './issue-labels';

export interface IssueDraft {
    kind: IssueKind | null;
    severity: IssueSeverity | null;
    title: string;
    body: string;
}

export const EMPTY_ISSUE_DRAFT: IssueDraft = { kind: null, severity: null, title: '', body: '' };

const draftKeyOf = (chatId: number): string => `draft:issue:${chatId}`;

export const isBlankIssueDraft = (draft: IssueDraft): boolean =>
    draft.kind === null && draft.severity === null && draft.title.trim() === '' && draft.body.trim() === '';

/** A stored draft; fields that do not parse are dropped, and anything unreadable is no draft */
const parseIssueDraft = (raw: string): IssueDraft | null => {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    return {
        kind: 'kind' in value && typeof value.kind === 'string' ? parseIssueKind(value.kind) : null,
        severity: 'severity' in value && typeof value.severity === 'string' ? parseIssueSeverity(value.severity) : null,
        title: 'title' in value && typeof value.title === 'string' ? value.title : '',
        body: 'body' in value && typeof value.body === 'string' ? value.body : '',
    };
};

export interface IssueDraftStart {
    draft: IssueDraft;
    restoredFromDraft: boolean;
}

/** Where the form starts: the stored draft when there is a non-blank one */
export const restoreIssueDraft = (chatId: number): IssueDraftStart => {
    const raw = readStorage(draftKeyOf(chatId));
    const draft = raw === null ? null : parseIssueDraft(raw);
    if (draft === null || isBlankIssueDraft(draft)) return { draft: EMPTY_ISSUE_DRAFT, restoredFromDraft: false };
    return { draft, restoredFromDraft: true };
};

/** Stores the draft, or drops it once the form is blank again */
export const storeIssueDraft = (chatId: number, draft: IssueDraft): void => {
    if (isBlankIssueDraft(draft)) removeStorage(draftKeyOf(chatId));
    else writeStorage(draftKeyOf(chatId), JSON.stringify(draft));
};

export const clearIssueDraft = (chatId: number): void => removeStorage(draftKeyOf(chatId));
