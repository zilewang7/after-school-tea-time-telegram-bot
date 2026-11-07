/**
 * Request parsing of the issue endpoints: the path id, the list query and the
 * POST / PATCH bodies. Every failure is a 400 `invalid`; messages never echo
 * request data.
 */
import { match } from 'ts-pattern';
import {
    normalizeHarnessIssueNote,
    parseHarnessIssueInput,
    type HarnessIssueInput,
    type HarnessIssueInputProblem,
} from '../../services/harness-issue-input.js';
import {
    HARNESS_ISSUE_BODY_MAX,
    HARNESS_ISSUE_KINDS,
    HARNESS_ISSUE_SEVERITIES,
    HARNESS_ISSUE_SOURCES,
    HARNESS_ISSUE_STATUSES,
    HARNESS_ISSUE_TITLE_MAX,
    type HarnessIssuePatch,
    type HarnessIssueStatus,
} from '../../services/harness-issue-service.js';
import type { PanelContext } from '../context.js';
import { PANEL_MESSAGES } from '../errors.js';
import type { JsonRecord } from '../json.js';
import type { PanelIssueFilters } from '../queries/harness-issues.js';
import { checkBodyKeys, invalid, parseChatId, parseOptionalPositiveInteger } from '../request.js';

export const ISSUE_PAGE_LIMIT_DEFAULT = 20;
export const ISSUE_PAGE_LIMIT_MAX = 50;
export const ISSUE_PAGE_OFFSET_MAX = 100_000;
export const ISSUE_KEYWORD_MAX = 100;

const ISSUE_ID_PATTERN = /^\d{1,10}$/;
const OFFSET_PATTERN = /^\d{1,6}$/;

const CREATE_KEYS: ReadonlySet<string> = new Set(['chatId', 'kind', 'severity', 'title', 'body']);
const PATCH_KEYS = ['status', 'note'] as const;
const PATCH_KEY_SET: ReadonlySet<string> = new Set(PATCH_KEYS);

export const parseIssueId = (raw: string | undefined): number => {
    if (raw === undefined || !ISSUE_ID_PATTERN.test(raw)) throw invalid('issue id 不合法');
    const issueId = Number(raw);
    if (issueId < 1) throw invalid('issue id 不合法');
    return issueId;
};

/** One of `allowed`; absent or empty means "no filter" */
const parseEnumParam = <T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T | undefined => {
    if (raw === undefined || raw === '') return undefined;
    const value = allowed.find((candidate) => candidate === raw);
    if (value === undefined) throw invalid(`${name} 必须是 ${allowed.join(' / ')} 之一`);
    return value;
};

const parseOffset = (raw: string | undefined): number => {
    if (raw === undefined || raw === '') return 0;
    if (!OFFSET_PATTERN.test(raw)) throw invalid('offset 必须是非负整数');
    const offset = Number(raw);
    if (offset > ISSUE_PAGE_OFFSET_MAX) throw invalid(`offset 不能超过 ${ISSUE_PAGE_OFFSET_MAX}`);
    return offset;
};

const parseKeyword = (raw: string | undefined): string | undefined => {
    const keyword = raw?.trim() ?? '';
    if (keyword === '') return undefined;
    if (keyword.length > ISSUE_KEYWORD_MAX) throw invalid(`关键词不能超过 ${ISSUE_KEYWORD_MAX} 字`);
    return keyword;
};

export interface IssueListRequest {
    filters: PanelIssueFilters;
    limit: number;
    offset: number;
}

/** GET /api/issues?status=&kind=&severity=&source=&chatId=&q=&limit=&offset= */
export const parseIssueListQuery = (context: PanelContext): IssueListRequest => {
    const rawChatId = context.req.query('chatId');
    return {
        filters: {
            status: parseEnumParam(context.req.query('status'), HARNESS_ISSUE_STATUSES, 'status'),
            kind: parseEnumParam(context.req.query('kind'), HARNESS_ISSUE_KINDS, 'kind'),
            severity: parseEnumParam(context.req.query('severity'), HARNESS_ISSUE_SEVERITIES, 'severity'),
            source: parseEnumParam(context.req.query('source'), HARNESS_ISSUE_SOURCES, 'source'),
            chatId: rawChatId === undefined || rawChatId === '' ? undefined : parseChatId(rawChatId),
            keyword: parseKeyword(context.req.query('q')),
        },
        limit:
            parseOptionalPositiveInteger(context.req.query('limit'), 'limit', ISSUE_PAGE_LIMIT_MAX) ??
            ISSUE_PAGE_LIMIT_DEFAULT,
        offset: parseOffset(context.req.query('offset')),
    };
};

/** A chat id in a JSON body: a number, or the digit string a path would carry */
const parseBodyChatId = (value: unknown): number => {
    if (typeof value === 'string') return parseChatId(value);
    if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) return value;
    throw invalid(PANEL_MESSAGES.invalidChatId);
};

/** POST body, step one (before the chat's access check): known keys only, and the chat */
export const parseIssueCreateTarget = (body: JsonRecord): number => {
    checkBodyKeys(body, CREATE_KEYS);
    return parseBodyChatId(body['chatId']);
};

/** The shared input check's refusals, worded for the panel's user */
const createProblemMessage = (problem: HarnessIssueInputProblem): string =>
    match(problem)
        .with('missing', () => '标题、正文和类型都必须填写')
        .with('title_too_long', () => `标题不能超过 ${HARNESS_ISSUE_TITLE_MAX} 字`)
        .with('body_too_long', () => `正文不能超过 ${HARNESS_ISSUE_BODY_MAX} 字`)
        .with('bad_kind', () => `类型必须是 ${HARNESS_ISSUE_KINDS.join(' / ')} 之一`)
        .with('bad_severity', () => `严重程度必须是 ${HARNESS_ISSUE_SEVERITIES.join(' / ')} 之一`)
        .exhaustive();

/** POST body, step two: the issue fields, through the same check as the model's tool */
export const parseIssueCreateInput = (body: JsonRecord): HarnessIssueInput => {
    const parsed = parseHarnessIssueInput(body);
    if (!parsed.ok) throw invalid(createProblemMessage(parsed.problem));
    return parsed.value;
};

const parseStatusValue = (value: unknown): HarnessIssueStatus => {
    const status = HARNESS_ISSUE_STATUSES.find((candidate) => candidate === value);
    if (status === undefined) throw invalid(`status 必须是 ${HARNESS_ISSUE_STATUSES.join(' / ')} 之一`);
    return status;
};

const parseNoteValue = (value: unknown): string | null => {
    const normalized = normalizeHarnessIssueNote(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

/** PATCH body: `{ status?, note? }`, at least one of them and nothing else */
export const parseIssuePatch = (body: JsonRecord): HarnessIssuePatch => {
    checkBodyKeys(body, PATCH_KEY_SET, PATCH_KEYS);
    return {
        ...(Object.hasOwn(body, 'status') ? { status: parseStatusValue(body['status']) } : {}),
        ...(Object.hasOwn(body, 'note') ? { note: parseNoteValue(body['note']) } : {}),
    };
};
