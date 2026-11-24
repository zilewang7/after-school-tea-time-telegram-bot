/**
 * Network plumbing shared by the reverse-search engines: browser headers, the
 * failure taxonomy each engine speaks, and the abort/timeout helpers.
 *
 * An engine reports trouble by throwing `ReverseSearchFailure`; the service
 * turns that into one engine-run entry, so a failing engine degrades the answer
 * instead of breaking it.
 */
import { getErrorMessage, isTimeoutError } from '../shared/errors.js';
import type { ReverseSearchErrorKind } from './image-reverse-search-types.js';

/** The browser headers the Yandex upload and the SauceNAO form were verified with */
export const BROWSER_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
} as const;

/** One engine's classified failure, as the engine modules throw it */
export class ReverseSearchFailure extends Error {
    constructor(
        readonly kind: ReverseSearchErrorKind,
        message: string
    ) {
        super(message);
        this.name = 'ReverseSearchFailure';
    }
}

/** A request timeout that the caller's signal can also end */
export const requestSignal = (timeoutMs: number, outer: AbortSignal | undefined): AbortSignal =>
    outer === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);

const causeCodeOf = (error: unknown): string | undefined => {
    if (!(error instanceof Error)) return undefined;
    const cause = error.cause;
    if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
    return typeof cause.code === 'string' ? cause.code : undefined;
};

export const isAbortLike = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || isTimeoutError(error));

const isNetworkFailure = (error: unknown): boolean => {
    if (error instanceof TypeError) return true;
    const code = causeCodeOf(error);
    return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
};

const shouldRetry = (error: unknown): boolean => {
    if (error instanceof ReverseSearchFailure) return error.kind === 'network';
    return !isAbortLike(error) && isNetworkFailure(error);
};

/**
 * One retry for a network blip. A rate limit, a captcha wall or a parse failure
 * is not a blip: repeating those would only spend another request.
 */
export const withNetworkRetry = async <T>(operation: () => Promise<T>, delayMs: number): Promise<T> => {
    try {
        return await operation();
    } catch (error) {
        if (!shouldRetry(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return operation();
    }
};

export interface ReverseSearchFailureInfo {
    readonly kind: ReverseSearchErrorKind;
    readonly error: string;
}

/** A thrown error as the engine-run entry and the tool text want it */
export const failureOf = (
    error: unknown,
    signal: AbortSignal | undefined,
    engineLabel: string
): ReverseSearchFailureInfo => {
    if (error instanceof ReverseSearchFailure) {
        return { kind: error.kind, error: error.message };
    }
    if (isAbortLike(error)) {
        return signal?.aborted === true
            ? { kind: 'aborted', error: '以图搜图请求已取消。' }
            : { kind: 'timeout', error: `以图搜图超时：${engineLabel} 没有在限定时间内返回。` };
    }
    return { kind: 'network', error: `${engineLabel} 请求失败：${getErrorMessage(error)}` };
};

/**
 * A captcha / Cloudflare wall served instead of the payload. Yandex has its own
 * captcha, SauceNAO sits behind Cloudflare; either page must read as `blocked`,
 * never as an empty result.
 */
export const looksLikeChallenge = (body: string, finalUrl: string): boolean =>
    /showcaptcha/i.test(finalUrl) ||
    /showcaptcha|smartcaptcha|Ой!/i.test(body.slice(0, 20_000)) ||
    /just a moment|cf-chl|challenge-platform|attention required/i.test(body.slice(0, 20_000));

/** The fetch to use: the injected one (tests) or the process-wide one, read per request */
export const fetchOf = (impl: typeof fetch | undefined): typeof fetch =>
    impl ?? ((input, init) => globalThis.fetch(input, init));
