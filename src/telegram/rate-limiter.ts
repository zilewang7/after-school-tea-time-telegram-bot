/**
 * Rate limiter for Telegram message editing
 * Prevents hitting Telegram's rate limits for editMessageText
 */
import {
    getRateLimiterEntry,
    setRateLimiterEntry,
} from '../state';

interface RateLimitConfig {
    /** Max edits per minute */
    maxEditsPerMinute: number;
    /** Minimum interval between edits in first 10 edits (ms) */
    minIntervalEarly: number;
    /** Time window for rate limiting (ms) */
    windowMs: number;
}

const defaultConfig: RateLimitConfig = {
    maxEditsPerMinute: 20,
    minIntervalEarly: 500,
    windowMs: 60000,
};

/**
 * Calculate delay before next edit is allowed
 */
export const calculateEditDelay = (
    chatId: number | string,
    config: RateLimitConfig = defaultConfig
): number => {
    const now = Date.now();
    let limiter = getRateLimiterEntry(chatId);

    if (!limiter) {
        limiter = { count: 0, startTimestamp: now, lastEditTimestamp: now };
        setRateLimiterEntry(chatId, limiter);
    }

    // Reset window if expired
    if (now - limiter.startTimestamp >= config.windowMs) {
        limiter.count = 0;
        limiter.startTimestamp = now;
        limiter.lastEditTimestamp = now;
    }

    let delay = 0;

    if (limiter.count < 10) {
        // First 10 edits: use fixed minimum interval
        const nextTime = limiter.lastEditTimestamp + config.minIntervalEarly;
        delay = Math.max(0, nextTime - now);
    } else {
        // After 10 edits: dynamically calculate delay based on remaining quota
        const remainingQuota = config.maxEditsPerMinute - limiter.count || 1;
        const remainingTime = config.windowMs - (now - limiter.startTimestamp);
        const dynamicDelay = remainingTime / remainingQuota;
        const nextTime = limiter.lastEditTimestamp + dynamicDelay;
        delay = Math.max(0, nextTime - now);
    }

    return delay;
};

/**
 * Record an edit operation
 */
export const recordEdit = (chatId: number | string): void => {
    const now = Date.now();
    let limiter = getRateLimiterEntry(chatId);

    if (!limiter) {
        limiter = { count: 0, startTimestamp: now, lastEditTimestamp: now };
    }

    limiter.count++;
    limiter.lastEditTimestamp = now;
    setRateLimiterEntry(chatId, limiter);
};

/**
 * Wait for rate limit delay and record edit
 */
export const waitForRateLimit = async (chatId: number | string): Promise<void> => {
    const delay = calculateEditDelay(chatId);
    if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    recordEdit(chatId);
};

/**
 * Create a rate-limited wrapper for a function
 */
export const withRateLimit = <T extends (...args: any[]) => Promise<any>>(
    chatId: number | string,
    fn: T
): ((...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>) => {
    return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
        await waitForRateLimit(chatId);
        return fn(...args);
    };
};
