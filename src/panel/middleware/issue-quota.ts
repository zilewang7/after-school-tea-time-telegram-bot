/**
 * How many issues one user may file from the panel (design §4.3: 5 per hour,
 * on top of the per-minute request limit): a sliding window per user id, in
 * memory, so a restart forgets it.
 *
 * POST /api/issues takes a slot before it looks at the request (the rate
 * limit comes before access and validation, design §7) and hands it back
 * unless an issue was actually filed, so refused requests cost nothing.
 * Taking is synchronous, so concurrent requests can never overshoot.
 */
import { PanelError } from '../errors.js';

export interface IssueQuotaLimits {
    /** Issues allowed per window */
    limit: number;
    windowMs: number;
}

export const DEFAULT_ISSUE_QUOTA: IssueQuotaLimits = { limit: 5, windowMs: 60 * 60 * 1000 };

export interface IssueQuotaOptions extends IssueQuotaLimits {
    /** Clock in ms */
    now: () => number;
}

export interface IssueQuotaSlot {
    /** Give the slot back (nothing was filed); a second call does nothing */
    release(): void;
}

export interface IssueQuota {
    /** Throws a 429 `rate_limited` with Retry-After when the user's window is full */
    take(userId: number): IssueQuotaSlot;
}

/** Above this many tracked users, users without a slot in the window are swept */
const SWEEP_THRESHOLD = 1000;

export const createIssueQuota = (options: IssueQuotaOptions): IssueQuota => {
    /** Per user: when each slot still in the window was taken (ms), oldest first */
    const slotTimes = new Map<number, number[]>();

    const recentSlots = (userId: number, now: number): number[] =>
        (slotTimes.get(userId) ?? []).filter((takenAt) => now - takenAt < options.windowMs);

    const sweep = (now: number): void => {
        // Deleting the current entry while iterating a Map is safe
        for (const userId of slotTimes.keys()) {
            if (recentSlots(userId, now).length === 0) slotTimes.delete(userId);
        }
    };

    const release = (userId: number, takenAt: number): void => {
        const times = slotTimes.get(userId);
        if (times === undefined) return;
        const index = times.indexOf(takenAt);
        if (index >= 0) times.splice(index, 1);
        if (times.length === 0) slotTimes.delete(userId);
    };

    return {
        take: (userId) => {
            const now = options.now();
            if (slotTimes.size > SWEEP_THRESHOLD) sweep(now);
            const recent = recentSlots(userId, now);
            if (recent.length >= options.limit) {
                slotTimes.set(userId, recent);
                // The window frees up when its oldest slot ages out
                const oldest = recent[0] ?? now;
                const retryAfterSeconds = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
                throw new PanelError('rate_limited', '提交 issue 过于频繁，请稍后再试', { retryAfterSeconds });
            }
            recent.push(now);
            slotTimes.set(userId, recent);

            let released = false;
            return {
                release: () => {
                    if (released) return;
                    released = true;
                    release(userId, now);
                },
            };
        },
    };
};
