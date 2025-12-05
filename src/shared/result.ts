/**
 * Result utilities for flattened error handling using await-to-js
 */
import to from 'await-to-js';

// Re-export to function
export { to };

// Result type that matches await-to-js actual behavior
// Success: [null, T]
// Error: [Error, undefined]
export type Result<T, E = Error> = [null, T] | [E, undefined];

/**
 * Check if result is an error
 */
export const isErr = <T, E = Error>(result: Result<T, E>): result is [E, undefined] => {
    return result[0] !== null;
};

/**
 * Check if result is successful
 */
export const isOk = <T, E = Error>(result: Result<T, E>): result is [null, T] => {
    return result[0] === null;
};

/**
 * Unwrap result value or throw error
 */
export const unwrap = <T, E = Error>(result: Result<T, E>): T => {
    if (isErr(result)) {
        throw result[0];
    }
    return result[1];
};

/**
 * Unwrap result value or return default
 */
export const unwrapOr = <T, E = Error>(result: Result<T, E>, defaultValue: T): T => {
    if (isErr(result)) {
        return defaultValue;
    }
    return result[1];
};

/**
 * Map successful result value
 */
export const map = <T, U, E = Error>(
    result: Result<T, E>,
    fn: (value: T) => U
): Result<U, E> => {
    if (isErr(result)) {
        return [result[0], undefined];
    }
    return [null, fn(result[1])];
};

/**
 * Chain async operations with Result type
 */
export const chain = async <T, U>(
    result: Result<T, Error>,
    fn: (value: T) => Promise<U>
): Promise<Result<U, Error>> => {
    if (isErr(result)) {
        return [result[0], undefined];
    }
    return to(fn(result[1])) as Promise<Result<U, Error>>;
};

/**
 * Execute multiple async operations and collect results
 * Returns first error if any operation fails
 */
export const all = async <T extends readonly unknown[]>(
    ...promises: { [K in keyof T]: Promise<T[K]> }
): Promise<Result<T, Error>> => {
    const results = await Promise.all(promises.map(p => to(p)));

    for (const result of results) {
        if (isErr(result)) {
            return [result[0], undefined];
        }
    }

    return [null, results.map(r => r[1]) as unknown as T];
};

/**
 * Wrap a sync function that might throw into Result
 */
export const tryCatch = <T>(fn: () => T): Result<T, Error> => {
    try {
        return [null, fn()];
    } catch (error) {
        return [error instanceof Error ? error : new Error(String(error)), undefined];
    }
};

/**
 * Get error from result (for type narrowing after isErr check)
 */
export const getErr = <T, E = Error>(result: Result<T, E>): E => {
    return result[0] as E;
};

/**
 * Get value from result (for type narrowing after isOk check)
 */
export const getOk = <T, E = Error>(result: Result<T, E>): T => {
    return result[1] as T;
};
