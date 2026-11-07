/**
 * The one check of an issue's fields, shared by the model's create tool and
 * the panel's POST /api/issues, so both accept and refuse exactly the same
 * input: strings are trimmed; title, body and kind are required; the title is
 * at most 200 and the body at most 4000 characters; kind and severity come
 * from their lists. Each caller words a refusal for its own reader.
 */
import {
    HARNESS_ISSUE_BODY_MAX,
    HARNESS_ISSUE_KINDS,
    HARNESS_ISSUE_NOTE_MAX,
    HARNESS_ISSUE_SEVERITIES,
    HARNESS_ISSUE_TITLE_MAX,
    type HarnessIssueKind,
    type HarnessIssueSeverity,
} from './harness-issue-service.js';

export interface HarnessIssueInput {
    readonly title: string;
    readonly body: string;
    readonly kind: HarnessIssueKind;
    /** null when not given */
    readonly severity: HarnessIssueSeverity | null;
}

/**
 * Why an input was refused:
 * - missing: title, body or kind is absent, blank or not a string
 * - title_too_long / body_too_long: over the limit after trimming
 * - bad_kind: not bug / improvement / feature
 * - bad_severity: given (not absent, null or blank) but not low / medium / high
 */
export type HarnessIssueInputProblem = 'missing' | 'title_too_long' | 'body_too_long' | 'bad_kind' | 'bad_severity';

export type ParsedHarnessIssueInput =
    | { readonly ok: true; readonly value: HarnessIssueInput }
    | { readonly ok: false; readonly problem: HarnessIssueInputProblem };

const refuse = (problem: HarnessIssueInputProblem): ParsedHarnessIssueInput => ({ ok: false, problem });

/** The trimmed string; null when not a string or blank */
const trimmedString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const isKind = (value: string): value is HarnessIssueKind => HARNESS_ISSUE_KINDS.some((kind) => kind === value);

const isSeverity = (value: string): value is HarnessIssueSeverity =>
    HARNESS_ISSUE_SEVERITIES.some((severity) => severity === value);

type ParsedSeverity = { ok: true; value: HarnessIssueSeverity | null } | { ok: false };

/** Absent, null and blank mean "no severity"; anything else must be on the list */
const parseSeverity = (value: unknown): ParsedSeverity => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false };
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ok: true, value: null };
    return isSeverity(trimmed) ? { ok: true, value: trimmed } : { ok: false };
};

/** Problems are checked in this order: required fields, title, body, kind, severity */
export const parseHarnessIssueInput = (raw: Readonly<Record<string, unknown>>): ParsedHarnessIssueInput => {
    const title = trimmedString(raw['title']);
    const body = trimmedString(raw['body']);
    const kind = trimmedString(raw['kind']);
    if (title === null || body === null || kind === null) return refuse('missing');
    if (title.length > HARNESS_ISSUE_TITLE_MAX) return refuse('title_too_long');
    if (body.length > HARNESS_ISSUE_BODY_MAX) return refuse('body_too_long');
    if (!isKind(kind)) return refuse('bad_kind');
    const severity = parseSeverity(raw['severity']);
    if (!severity.ok) return refuse('bad_severity');
    return { ok: true, value: { title, body, kind, severity: severity.value } };
};

export type NormalizedHarnessIssueNote = { ok: true; value: string | null } | { ok: false; message: string };

/**
 * The owner's handling note: CRLF becomes LF, surrounding whitespace goes,
 * blank means none. Over 4000 characters is refused, never cut.
 */
export const normalizeHarnessIssueNote = (raw: unknown): NormalizedHarnessIssueNote => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: '处理备注必须是字符串或 null' };
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    if (normalized.length === 0) return { ok: true, value: null };
    if (normalized.length > HARNESS_ISSUE_NOTE_MAX) {
        return { ok: false, message: `处理备注不能超过 ${HARNESS_ISSUE_NOTE_MAX} 字（当前 ${normalized.length} 字）` };
    }
    return { ok: true, value: normalized };
};
