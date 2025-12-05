/**
 * Error handling utilities using ts-pattern
 */
import { match, P } from 'ts-pattern';

/**
 * Extract error message from unknown error
 */
export const getErrorMessage = (error: unknown): string => {
    return match(error)
        .with({ message: P.string }, e => e.message)
        .with(P.string, str => str)
        .with({ code: 'ECONNREFUSED' }, () => '无法连接到服务')
        .with({ code: 'ETIMEDOUT' }, () => '连接超时')
        .with({ status: 429 }, () => '请求过于频繁')
        .with({ status: P.number.gte(500).lte(599) }, () => '服务器内部错误')
        .otherwise(() => '未知错误');
};

/**
 * Check if error is retryable
 */
export const isRetryableError = (error: unknown): boolean => {
    return match(error)
        .with({ message: 'Timeout' }, () => true)
        .with({ message: P.string.includes('429') }, () => true)
        .with({ message: P.string.includes('rate limit') }, () => true)
        .with({ message: P.string.includes('exhausted') }, () => true)
        .with({ message: P.string.includes('ECONNRESET') }, () => true)
        .with({ message: P.string.includes('socket hang up') }, () => true)
        .with({ status: P.number.gte(500).lte(599) }, () => true)
        .with({ code: 'ETIMEDOUT' }, () => true)
        .with({ code: 'ECONNRESET' }, () => true)
        .otherwise(() => false);
};

/**
 * Check if error is rate limit error
 */
export const isRateLimitError = (error: unknown): boolean => {
    return match(error)
        .with({ message: P.string.includes('429') }, () => true)
        .with({ message: P.string.includes('rate limit') }, () => true)
        .with({ message: P.string.includes('exhausted') }, () => true)
        .with({ status: 429 }, () => true)
        .otherwise(() => false);
};

/**
 * Check if error is timeout error
 */
export const isTimeoutError = (error: unknown): boolean => {
    return match(error)
        .with({ message: 'Timeout' }, () => true)
        .with({ message: P.string.includes('timeout') }, () => true)
        .with({ code: 'ETIMEDOUT' }, () => true)
        .otherwise(() => false);
};

/**
 * Get appropriate wait time for retry based on error type
 */
export const getRetryWaitTime = (error: unknown): number => {
    return match(error)
        .when(isRateLimitError, () => 5000)
        .when(isTimeoutError, () => 1000)
        .otherwise(() => 2000);
};

/**
 * Format error for user display
 */
export const formatErrorForUser = (error: unknown, prefix?: string): string => {
    const message = match(error)
        .with({ message: P.string.includes('429') }, () => '请求过于频繁，请稍后重试')
        .with({ message: P.string.includes('Timeout') }, () => '请求超时，请重试')
        .with({ message: P.string.includes('ECONNREFUSED') }, () => '无法连接到 AI 服务')
        .with({ message: P.string.includes('rate limit') }, () => '已达到速率限制，请稍后重试')
        .with({ message: P.string }, e => e.message)
        .with(P.string, str => str)
        .otherwise(() => '发生未知错误');

    return prefix ? `${prefix}: ${message}` : message;
};

/**
 * Create a typed error class
 */
export class AppError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
        public readonly retryable: boolean = false
    ) {
        super(message);
        this.name = 'AppError';
    }

    static timeout(message = '请求超时'): AppError {
        return new AppError(message, 'TIMEOUT', true);
    }

    static rateLimit(message = '请求过于频繁'): AppError {
        return new AppError(message, 'RATE_LIMIT', true);
    }

    static network(message = '网络错误'): AppError {
        return new AppError(message, 'NETWORK', true);
    }

    static validation(message: string): AppError {
        return new AppError(message, 'VALIDATION', false);
    }

    static notFound(message: string): AppError {
        return new AppError(message, 'NOT_FOUND', false);
    }
}
