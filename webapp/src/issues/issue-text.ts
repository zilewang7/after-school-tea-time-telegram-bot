// Text limits of issues, counted the way the server checks them (harness-issue-input.ts).

export const ISSUE_TITLE_MAX = 200;
export const ISSUE_BODY_MAX = 4000;
export const ISSUE_NOTE_MAX = 4000;

/** UTF-16 length of the trimmed text, which is what the server compares with the limits */
export const issueTextLength = (text: string): number => text.trim().length;

/** The note to store: CRLF -> LF and trimmed; blank clears it (null) */
export const normalizeIssueNote = (text: string): string | null => {
    const normalized = text.replaceAll('\r\n', '\n').trim();
    return normalized === '' ? null : normalized;
};
