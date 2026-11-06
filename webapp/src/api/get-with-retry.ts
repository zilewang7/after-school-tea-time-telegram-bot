import type { ApiFailure, ApiResult } from './client';
import { clearUnreachable, markUnreachable } from './connectivity';

export const RETRY_DELAY_MS = 5000;

/** Banner text for a failure that should be retried, or null when the failure is final */
const retryBannerOf = (failure: ApiFailure): string | null => {
    if (failure.kind === 'network') return 'bot 不可达，5 秒后重试';
    if (failure.kind === 'unreachable') {
        return failure.serverMessage === null ? 'bot 不可达，5 秒后重试' : `${failure.serverMessage}，5 秒后重试`;
    }
    return null;
};

/** Resolves true after the delay, false as soon as the signal aborts */
const waitForRetry = (signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
        if (signal.aborted) {
            resolve(false);
            return;
        }
        const onAbort = (): void => {
            window.clearTimeout(timer);
            resolve(false);
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, RETRY_DELAY_MS);
        signal.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Runs a GET and retries it every 5s while the bot is unreachable, showing the top banner meanwhile.
 * Resolves with the first definitive result, or null once the signal aborts.
 * Only for reads: writes are never retried automatically.
 */
export const getWithRetry = async <T>(
    load: (signal: AbortSignal) => Promise<ApiResult<T>>,
    signal: AbortSignal
): Promise<ApiResult<T> | null> => {
    const token = Symbol('get-with-retry');
    try {
        for (;;) {
            const result = await load(signal);
            if (signal.aborted) return null;
            if (result.ok) return result;
            const banner = retryBannerOf(result.failure);
            if (banner === null) return result;
            markUnreachable(token, banner);
            const shouldRetry = await waitForRetry(signal);
            if (!shouldRetry) return null;
        }
    } finally {
        clearUnreachable(token);
    }
};
