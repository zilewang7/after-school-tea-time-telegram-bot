/**
 * Retry a write that lost the race for SQLite's write lock.
 *
 * `busy_timeout` (see config.ts) already makes a blocked writer wait instead of
 * failing, so reaching this code means the lock was held for longer than that —
 * rare, but it happened, and the message it was carrying was silently gone.
 * Ingest is the one path where losing a write is unrecoverable: the context tree
 * resolves ids to rows, so a missing row is a permanent hole.
 */

/** How many times a busy write is attempted in total */
const MAX_ATTEMPTS = 3;

/** First backoff; doubles per attempt, with jitter so retries don't line up */
const BASE_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A locked database surfaces as SequelizeTimeoutError wrapping SQLITE_BUSY.
 * Everything else (constraint violations, bad SQL) is not worth retrying.
 */
const isDatabaseLockedError = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    if (error.message.includes('SQLITE_BUSY')) return true;
    const cause = error.cause;
    return cause instanceof Error && cause.message.includes('SQLITE_BUSY');
};

/**
 * Run `operation`, retrying while the database is locked. `description` is only
 * used for logging — make it name the row being written.
 */
export const withBusyRetry = async <T>(
    operation: () => Promise<T>,
    description: string
): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= MAX_ATTEMPTS || !isDatabaseLockedError(error)) throw error;
            const backoff = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * BASE_DELAY_MS);
            console.warn(
                `[db] ${description}: database locked (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${backoff}ms`
            );
            await sleep(backoff);
        }
    }
};
