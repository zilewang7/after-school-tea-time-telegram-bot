/**
 * In-memory view of the access tier: who is admitted, and each user's latest
 * application (for the prompt's status line).
 *
 * Loaded once at startup, right after the chat settings cache, and kept in step
 * by the access service after every write. The reply path must decide a tier
 * synchronously — it never awaits the database for it.
 */
import {
    AccessApplication,
    isAccessApplicationStatus,
    type AccessApplicationStatus,
} from '../db/accessApplicationDTO.js';
import { UserAccess } from '../db/userAccessDTO.js';

/** What the prompt and the panel need to know about a user's latest application */
export interface LatestApplicationSummary {
    readonly id: number;
    readonly userId: number;
    readonly status: AccessApplicationStatus;
    readonly comment: string | null;
    readonly createdAt: Date;
}

/** null until the first load: callers then fall back to "not admitted" */
let admitted: Set<number> | null = null;
const latestByUser = new Map<number, LatestApplicationSummary>();
let loading: Promise<void> | null = null;

const summaryOf = (row: AccessApplication): LatestApplicationSummary => ({
    id: row.id,
    userId: row.userId,
    status: isAccessApplicationStatus(row.status) ? row.status : 'pending',
    comment: row.comment ?? null,
    createdAt: row.createdAt,
});

const readAll = async (): Promise<void> => {
    const [accessRows, applicationRows] = await Promise.all([
        UserAccess.findAll(),
        // Newest first, so the first row per user is their latest application
        AccessApplication.findAll({ order: [['id', 'DESC']] }),
    ]);
    const nextAdmitted = new Set(accessRows.map((row) => row.userId));
    const nextLatest = new Map<number, LatestApplicationSummary>();
    for (const row of applicationRows) {
        if (!nextLatest.has(row.userId)) nextLatest.set(row.userId, summaryOf(row));
    }
    admitted = nextAdmitted;
    latestByUser.clear();
    for (const [userId, summary] of nextLatest) latestByUser.set(userId, summary);
};

/** Load (or share one in-flight load of) the cache; a failed load may be retried */
export const loadUserAccessCache = (): Promise<void> => {
    loading ??= readAll().finally(() => {
        loading = null;
    });
    return loading;
};

export const isUserAccessCacheLoaded = (): boolean => admitted !== null;

export const isUserAdmitted = (userId: number): boolean => admitted?.has(userId) ?? false;

export const latestApplicationOf = (userId: number): LatestApplicationSummary | null =>
    latestByUser.get(userId) ?? null;

/** After a grant is committed */
export const rememberAdmission = (userId: number): void => {
    if (admitted !== null) admitted.add(userId);
};

/** After a grant is revoked */
export const forgetAdmission = (userId: number): void => {
    admitted?.delete(userId);
};

/** After an application is created or decided; keeps the newest row per user */
export const rememberApplication = (summary: LatestApplicationSummary): void => {
    const current = latestByUser.get(summary.userId);
    if (current === undefined || summary.id >= current.id) latestByUser.set(summary.userId, summary);
};
