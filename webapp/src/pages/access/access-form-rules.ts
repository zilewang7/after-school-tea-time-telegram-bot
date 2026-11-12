// Field limits of access applications, counted the way the server checks them.

import type { AccessApplicationCreate } from '../../api';

export const ACCESS_IDENTITY_MAX = 500;
export const ACCESS_PURPOSE_MAX = 1000;
/** The owner's review comment */
export const ACCESS_COMMENT_MAX = 500;

/** Trimmed UTF-16 length, which is what the server compares with the limits */
export const accessTextLength = (text: string): number => text.trim().length;

/** CRLF -> LF and trimmed; blank means "not filled in" */
export const normalizeAccessText = (text: string): string => text.replaceAll('\r\n', '\n').trim();

/** The owner's comment to store: blank clears it (null) */
export const normalizeAccessComment = (text: string): string | null => {
    const normalized = normalizeAccessText(text);
    return normalized === '' ? null : normalized;
};

export interface AccessApplicationDraft {
    identity: string;
    purpose: string;
}

/** The request to send; null while a field is blank or over its limit */
export const accessApplicationRequestOf = (draft: AccessApplicationDraft): AccessApplicationCreate | null => {
    const identity = normalizeAccessText(draft.identity);
    const purpose = normalizeAccessText(draft.purpose);
    if (identity === '' || purpose === '') return null;
    if (identity.length > ACCESS_IDENTITY_MAX || purpose.length > ACCESS_PURPOSE_MAX) return null;
    return { identity, purpose };
};
