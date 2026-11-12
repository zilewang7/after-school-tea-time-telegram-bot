/**
 * Request parsing of the access endpoints: path ids, the review list query and
 * the create / review bodies. Every failure is a 400 `invalid`; messages never
 * echo request data.
 */
import type { AccessReviewAction } from '../../services/user-access-service.js';
import type { PanelContext } from '../context.js';
import type { JsonRecord } from '../json.js';
import { checkBodyKeys, invalid, parseOptionalPositiveInteger } from '../request.js';

export const ACCESS_PAGE_LIMIT_DEFAULT = 20;
export const ACCESS_PAGE_LIMIT_MAX = 100;

const OFFSET_PATTERN = /^\d{1,15}$/;

const CREATE_KEYS = ['identity', 'purpose'] as const;
const CREATE_KEY_SET: ReadonlySet<string> = new Set(CREATE_KEYS);
const REVIEW_KEYS = ['action', 'comment'] as const;
const REVIEW_KEY_SET: ReadonlySet<string> = new Set(REVIEW_KEYS);

/** A required positive integer path id (an application id or a user id) */
export const parsePositiveId = (raw: string | undefined, name: string): number => {
    const value = parseOptionalPositiveInteger(raw, name);
    if (value === undefined) throw invalid(`${name} 不合法`);
    return value;
};

export type AccessListStatus = 'pending' | 'all';

export interface AccessListRequest {
    readonly status: AccessListStatus;
    readonly limit: number;
    readonly offset: number;
}

const parseStatus = (raw: string | undefined): AccessListStatus => {
    if (raw === undefined || raw === '') return 'pending';
    if (raw === 'pending' || raw === 'all') return raw;
    throw invalid('status 必须是 pending / all 之一');
};

const parseOffset = (raw: string | undefined): number => {
    if (raw === undefined || raw === '') return 0;
    if (!OFFSET_PATTERN.test(raw)) throw invalid('offset 必须是非负整数');
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset)) throw invalid('offset 必须是非负整数');
    return offset;
};

/** GET /api/access-applications?status=pending|all&limit=&offset= */
export const parseAccessListQuery = (context: PanelContext): AccessListRequest => ({
    status: parseStatus(context.req.query('status')),
    limit:
        parseOptionalPositiveInteger(context.req.query('limit'), 'limit', ACCESS_PAGE_LIMIT_MAX) ??
        ACCESS_PAGE_LIMIT_DEFAULT,
    offset: parseOffset(context.req.query('offset')),
});

/** POST /api/access-applications body: exactly the two fields, both required */
export interface AccessCreateFields {
    /** Passed to the service as-is: it validates types and lengths */
    readonly identity: unknown;
    readonly purpose: unknown;
}

/** The create body's fields, unvalidated: the service validates them */
export const parseAccessCreateBody = (body: JsonRecord): AccessCreateFields => {
    checkBodyKeys(body, CREATE_KEY_SET, CREATE_KEYS);
    return { identity: body['identity'], purpose: body['purpose'] };
};

/** PATCH /api/access-applications/:id body: an action and an optional comment */
export interface AccessReviewRequest {
    readonly action: AccessReviewAction;
    /** Passed to the service as-is: it validates the type and the length */
    readonly comment: unknown;
}

/** The review body, with the action already checked; the comment is left to the service */
export const parseAccessReviewBody = (body: JsonRecord): AccessReviewRequest => {
    checkBodyKeys(body, REVIEW_KEY_SET);
    const action = body['action'];
    if (action !== 'approve' && action !== 'reject') throw invalid('action 必须是 approve / reject 之一');
    return { action, comment: body['comment'] };
};
