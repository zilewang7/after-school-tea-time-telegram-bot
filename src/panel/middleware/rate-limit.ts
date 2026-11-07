/**
 * Per-user request limit: a fixed window per user id, opened by the user's
 * first request (in memory; a restart resets it). Runs after auth, so the key
 * is always a verified id.
 */
import type { MiddlewareHandler } from 'hono';
import { requireAuth, type PanelEnv } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';

export interface RateLimitOptions {
    /** Requests allowed per window */
    limit: number;
    windowMs: number;
    /** Clock in ms */
    now: () => number;
}

interface RateWindow {
    startedAt: number;
    count: number;
}

/** Above this many tracked users, finished windows are swept */
const SWEEP_THRESHOLD = 1000;

export const createRateLimit = (options: RateLimitOptions): MiddlewareHandler<PanelEnv> => {
    const windows = new Map<number, RateWindow>();

    const sweepFinished = (now: number): void => {
        for (const [userId, window] of windows) {
            if (now - window.startedAt >= options.windowMs) windows.delete(userId);
        }
    };

    return async (context, next) => {
        const userId = requireAuth(context).user.id;
        const now = options.now();
        if (windows.size > SWEEP_THRESHOLD) sweepFinished(now);

        const current = windows.get(userId);
        const window = current !== undefined && now - current.startedAt < options.windowMs
            ? current
            : { startedAt: now, count: 0 };
        windows.set(userId, window);
        window.count += 1;

        if (window.count > options.limit) {
            const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + options.windowMs - now) / 1000));
            throw new PanelError('rate_limited', PANEL_MESSAGES.rateLimited, { retryAfterSeconds });
        }
        await next();
    };
};
