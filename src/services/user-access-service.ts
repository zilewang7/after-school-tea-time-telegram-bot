/**
 * Access applications and the admitted list: the only write path for both.
 *
 * Both user-facing entry points (/apply and the Mini App form) and the owner's
 * review/revoke actions go through here, so field rules, the one-pending rule
 * and the audit entries exist once. Writes for one user or one application run
 * one at a time; the in-memory tier cache is updated only after the commit.
 */
import type { Transaction } from '@sequelize/core';
import { withBusyRetry } from '../db/busy-retry.js';
import { sequelize } from '../db/config.js';
import {
    AccessApplication,
    isAccessApplicationSource,
    isAccessApplicationStatus,
    isAccessDeliveryStatus,
    type AccessApplicationSource,
    type AccessApplicationStatus,
    type AccessDeliveryStatus,
} from '../db/accessApplicationDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';
import { UserAccess } from '../db/userAccessDTO.js';
import {
    ACCESS_IDENTITY_MAX_CODE_POINTS,
    ACCESS_PURPOSE_MAX_CODE_POINTS,
    ACCESS_REVIEW_COMMENT_MAX_CODE_POINTS,
} from '../config/trial-access.js';
import { resolveAccessTier } from './access-tier.js';
import { countCodePoints } from './chat-settings-rules.js';
import {
    forgetAdmission,
    rememberAdmission,
    rememberApplication,
    type LatestApplicationSummary,
} from './user-access-cache.js';

/** One application as the service hands it around (dates are Date, nulls explicit) */
export interface AccessApplicationRecord {
    readonly id: number;
    readonly userId: number;
    readonly chatId: number;
    readonly messageId: number | null;
    readonly identity: string;
    readonly purpose: string;
    readonly source: AccessApplicationSource;
    readonly status: AccessApplicationStatus;
    readonly comment: string | null;
    readonly reviewedBy: number | null;
    readonly reviewedAt: Date | null;
    readonly deliveryStatus: AccessDeliveryStatus | null;
    readonly deliveryError: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export type AccessApplicationErrorCode =
    | 'invalid'
    | 'pending'
    | 'already_full'
    | 'not_found'
    | 'decided'
    | 'not_admitted';

/** A refusal the route/command turns into a user-visible message */
export class AccessApplicationError extends Error {
    readonly code: AccessApplicationErrorCode;

    constructor(code: AccessApplicationErrorCode, message: string) {
        super(message);
        this.name = 'AccessApplicationError';
        this.code = code;
    }
}

export const accessApplicationAuditScope = (applicationId: number): string =>
    `access:${applicationId}`;

export const userAccessAuditScope = (userId: number): string => `user-access:${userId}`;

const deliveryStatusOf = (raw: string | null): AccessDeliveryStatus | null =>
    raw !== null && isAccessDeliveryStatus(raw) ? raw : null;

export const toAccessApplicationRecord = (row: AccessApplication): AccessApplicationRecord => ({
    id: row.id,
    userId: row.userId,
    chatId: row.chatId,
    messageId: row.messageId ?? null,
    identity: row.identity,
    purpose: row.purpose,
    source: isAccessApplicationSource(row.source) ? row.source : 'command',
    status: isAccessApplicationStatus(row.status) ? row.status : 'pending',
    comment: row.comment ?? null,
    reviewedBy: row.reviewedBy ?? null,
    reviewedAt: row.reviewedAt ?? null,
    deliveryStatus: deliveryStatusOf(row.deliveryStatus ?? null),
    deliveryError: row.deliveryError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const latestSummaryOf = (record: AccessApplicationRecord): LatestApplicationSummary => ({
    id: record.id,
    userId: record.userId,
    status: record.status,
    comment: record.comment,
    createdAt: record.createdAt,
});

/**
 * All access writes run one at a time. One scope, not one per user: an approve
 * and a revoke of the same user must not interleave (a late approve would
 * re-insert a grant the owner just removed). The volume is a handful of writes.
 */
const ACCESS_WRITE_SCOPE = 'access-writes';
const writeQueues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task of the same scope has settled */
const runSerialized = <T>(scope: string, task: () => Promise<T>): Promise<T> => {
    const previous = writeQueues.get(scope) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    writeQueues.set(scope, tail);
    // Drop the entry once it is the tail again: the map must not grow forever
    void tail.then(() => {
        if (writeQueues.get(scope) === tail) writeQueues.delete(scope);
    });
    return current;
};

const invalid = (message: string): AccessApplicationError =>
    new AccessApplicationError('invalid', message);

const normalizeField = (raw: unknown, max: number, label: string): string => {
    if (typeof raw !== 'string') throw invalid(`${label} 必须是字符串`);
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw invalid(`${label} 不能为空`);
    const length = countCodePoints(trimmed);
    if (length > max) throw invalid(`${label} 不能超过 ${max} 字（当前 ${length} 字）`);
    return trimmed;
};

export interface AccessApplicationFields {
    readonly identity: string;
    readonly purpose: string;
}

/** Both application fields, trimmed and within their limits */
export const normalizeAccessApplicationFields = (raw: {
    readonly identity: unknown;
    readonly purpose: unknown;
}): AccessApplicationFields => ({
    identity: normalizeField(raw.identity, ACCESS_IDENTITY_MAX_CODE_POINTS, '你是谁'),
    purpose: normalizeField(raw.purpose, ACCESS_PURPOSE_MAX_CODE_POINTS, '你要做什么'),
});

/** The owner's optional message; blank means none, too long is an error */
export const normalizeReviewComment = (raw: unknown): string | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') throw invalid('留言必须是字符串');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const length = countCodePoints(trimmed);
    if (length > ACCESS_REVIEW_COMMENT_MAX_CODE_POINTS) {
        throw invalid(`留言不能超过 ${ACCESS_REVIEW_COMMENT_MAX_CODE_POINTS} 字（当前 ${length} 字）`);
    }
    return trimmed;
};

export interface CreateAccessApplicationInput {
    readonly userId: number;
    readonly chatId: number;
    readonly messageId: number | null;
    readonly identity: unknown;
    readonly purpose: unknown;
    readonly source: AccessApplicationSource;
}

/**
 * File one application. Refuses when the user already has the full tier or a
 * pending application (the one-pending rule), inside a per-user serialized
 * transaction so two submissions cannot both pass the check.
 */
export const createAccessApplication = async (
    input: CreateAccessApplicationInput
): Promise<AccessApplicationRecord> => {
    const fields = normalizeAccessApplicationFields({ identity: input.identity, purpose: input.purpose });
    const record = await runSerialized(ACCESS_WRITE_SCOPE, () =>
        withBusyRetry(
            () =>
                sequelize.transaction(async (transaction) => {
                    if (resolveAccessTier(input.userId) !== 'trial') {
                        throw new AccessApplicationError('already_full', '你已拥有完整权限，无需申请');
                    }
                    const pending = await AccessApplication.findOne({
                        where: { userId: input.userId, status: 'pending' },
                        transaction,
                    });
                    if (pending !== null) {
                        throw new AccessApplicationError(
                            'pending',
                            '你已有一条待审核的准入申请，请等待机主审核'
                        );
                    }
                    const now = new Date();
                    const row = await AccessApplication.create(
                        {
                            userId: input.userId,
                            chatId: input.chatId,
                            messageId: input.messageId,
                            identity: fields.identity,
                            purpose: fields.purpose,
                            source: input.source,
                            status: 'pending',
                            createdAt: now,
                            updatedAt: now,
                        },
                        { transaction }
                    );
                    await writeSettingsAudit(
                        {
                            actorId: input.userId,
                            scope: accessApplicationAuditScope(row.id),
                            key: 'create',
                            oldValue: null,
                            newValue: JSON.stringify({ chatId: input.chatId, source: input.source }),
                        },
                        { transaction }
                    );
                    return toAccessApplicationRecord(row);
                }),
            `access application by ${input.userId}`
        )
    );
    rememberApplication(latestSummaryOf(record));
    return record;
};

export type AccessReviewAction = 'approve' | 'reject';

export interface ReviewAccessApplicationInput {
    readonly applicationId: number;
    readonly action: AccessReviewAction;
    readonly comment: unknown;
    readonly actorId: number;
}

/** Insert or refresh the grant that makes a user full; runs inside the review transaction */
const grantUserAccess = async (input: {
    readonly userId: number;
    readonly applicationId: number;
    readonly actorId: number;
    readonly now: Date;
    readonly transaction: Transaction;
}): Promise<void> => {
    const existing = await UserAccess.findByPk(input.userId, { transaction: input.transaction });
    if (existing === null) {
        await UserAccess.create(
            {
                userId: input.userId,
                source: 'application',
                applicationId: input.applicationId,
                grantedBy: input.actorId,
                grantedAt: input.now,
                updatedAt: input.now,
            },
            { transaction: input.transaction }
        );
        return;
    }
    existing.source = 'application';
    existing.applicationId = input.applicationId;
    existing.grantedBy = input.actorId;
    existing.grantedAt = input.now;
    existing.updatedAt = input.now;
    await existing.save({ transaction: input.transaction });
};

/**
 * The owner's decision. Only a pending application can be decided; approving
 * writes the grant in the same transaction. The cache is updated after commit.
 */
export const reviewAccessApplication = async (
    input: ReviewAccessApplicationInput
): Promise<AccessApplicationRecord> => {
    const comment = normalizeReviewComment(input.comment);
    const record = await runSerialized(ACCESS_WRITE_SCOPE, () =>
        withBusyRetry(
            () =>
                sequelize.transaction(async (transaction) => {
                    const row = await AccessApplication.findByPk(input.applicationId, { transaction });
                    if (row === null) throw new AccessApplicationError('not_found', '这条申请不存在');
                    if (row.status !== 'pending') {
                        throw new AccessApplicationError('decided', '这条申请已经处理过了');
                    }
                    const now = new Date();
                    const nextStatus: AccessApplicationStatus =
                        input.action === 'approve' ? 'approved' : 'rejected';
                    row.status = nextStatus;
                    row.comment = comment;
                    row.reviewedBy = input.actorId;
                    row.reviewedAt = now;
                    row.updatedAt = now;
                    await row.save({ transaction });
                    if (nextStatus === 'approved') {
                        await grantUserAccess({
                            userId: row.userId,
                            applicationId: row.id,
                            actorId: input.actorId,
                            now,
                            transaction,
                        });
                    }
                    await writeSettingsAudit(
                        {
                            actorId: input.actorId,
                            scope: accessApplicationAuditScope(row.id),
                            key: input.action,
                            oldValue: 'pending',
                            newValue: nextStatus,
                        },
                        { transaction }
                    );
                    if (comment !== null) {
                        await writeSettingsAudit(
                            {
                                actorId: input.actorId,
                                scope: accessApplicationAuditScope(row.id),
                                key: 'comment',
                                oldValue: null,
                                newValue: comment,
                            },
                            { transaction }
                        );
                    }
                    return toAccessApplicationRecord(row);
                }),
            `review access application ${input.applicationId}`
        )
    );
    if (record.status === 'approved') rememberAdmission(record.userId);
    rememberApplication(latestSummaryOf(record));
    return record;
};

export interface RevokeUserAccessResult {
    readonly userId: number;
    /** The latest approved application, whose chat is the delivery target; null when unknown */
    readonly lastApproved: AccessApplicationRecord | null;
}

/** Take the grant away; the user becomes a trial user again */
export const revokeUserAccess = async (input: {
    readonly userId: number;
    readonly actorId: number;
}): Promise<RevokeUserAccessResult> => {
    const result = await runSerialized(ACCESS_WRITE_SCOPE, () =>
        withBusyRetry(
            () =>
                sequelize.transaction(async (transaction) => {
                    const row = await UserAccess.findByPk(input.userId, { transaction });
                    if (row === null) {
                        throw new AccessApplicationError('not_admitted', '该用户不在准入名单里');
                    }
                    await row.destroy({ transaction });
                    const lastApproved = await AccessApplication.findOne({
                        where: { userId: input.userId, status: 'approved' },
                        order: [['id', 'DESC']],
                        transaction,
                    });
                    await writeSettingsAudit(
                        {
                            actorId: input.actorId,
                            scope: userAccessAuditScope(input.userId),
                            key: 'revoke',
                            oldValue: 'granted',
                            newValue: 'revoked',
                        },
                        { transaction }
                    );
                    return {
                        userId: input.userId,
                        lastApproved:
                            lastApproved === null ? null : toAccessApplicationRecord(lastApproved),
                    };
                }),
            `revoke access ${input.userId}`
        )
    );
    forgetAdmission(input.userId);
    return result;
};

export const markApplicationDelivery = async (input: {
    readonly applicationId: number;
    readonly status: AccessDeliveryStatus;
    readonly error: string | null;
}): Promise<void> => {
    await AccessApplication.update(
        {
            deliveryStatus: input.status,
            deliveryError: input.error,
            updatedAt: new Date(),
        },
        { where: { id: input.applicationId } }
    );
};

export const findAccessApplication = async (
    applicationId: number
): Promise<AccessApplicationRecord | null> => {
    const row = await AccessApplication.findByPk(applicationId);
    return row === null ? null : toAccessApplicationRecord(row);
};

export interface ListAccessApplicationsQuery {
    /** 'pending' (default) shows only what still needs a decision */
    readonly status?: 'pending' | 'all';
    readonly limit?: number;
    readonly offset?: number;
}

export interface ListAccessApplicationsResult {
    readonly records: readonly AccessApplicationRecord[];
    readonly matched: number;
    readonly pending: number;
}

export const listAccessApplications = async (
    query: ListAccessApplicationsQuery = {}
): Promise<ListAccessApplicationsResult> => {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 20)), 100);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const where = query.status === 'all' ? {} : { status: 'pending' };
    const [rows, matched, pending] = await Promise.all([
        AccessApplication.findAll({ where, order: [['id', 'DESC']], limit, offset }),
        AccessApplication.count({ where }),
        AccessApplication.count({ where: { status: 'pending' } }),
    ]);
    return { records: rows.map(toAccessApplicationRecord), matched, pending };
};

export const listAccessApplicationsByUser = async (
    userId: number,
    limit = 20
): Promise<readonly AccessApplicationRecord[]> => {
    const rows = await AccessApplication.findAll({
        where: { userId },
        order: [['id', 'DESC']],
        limit: Math.min(Math.max(1, Math.trunc(limit)), 100),
    });
    return rows.map(toAccessApplicationRecord);
};

export const countPendingApplications = async (): Promise<number> =>
    AccessApplication.count({ where: { status: 'pending' } });

export const findLatestApprovedApplication = async (
    userId: number
): Promise<AccessApplicationRecord | null> => {
    const row = await AccessApplication.findOne({
        where: { userId, status: 'approved' },
        order: [['id', 'DESC']],
    });
    return row === null ? null : toAccessApplicationRecord(row);
};
