/**
 * What kind of failure ended a reply, for the panel's error statistics
 * (design §6.5). The HTTP status decides first (429 rate limit, 5xx
 * upstream), then our own error codes, then the error's name / code / text:
 * a failure in the middle of a stream is a plain Error without a status, so
 * its text is all there is.
 */
import { match, P } from 'ts-pattern';
import { AppError } from './errors.js';
import { isJsonObject } from './json-object.js';

export type ErrorKind =
    | 'rate_limit'
    | 'timeout'
    | 'network'
    | 'upstream'
    | 'content_filter'
    | 'pre_request'
    | 'other';

export const ERROR_KINDS: readonly ErrorKind[] = [
    'rate_limit',
    'timeout',
    'network',
    'upstream',
    'content_filter',
    'pre_request',
    'other',
];

export interface ErrorKindOptions {
    /** The reply failed before its model request went out (reading the message, building the context) */
    readonly beforeRequest?: boolean;
}

/** What classification looks at, read loosely from whatever was thrown */
interface ErrorFacts {
    readonly status: number | null;
    readonly appCode: string | null;
    /** The system / undici code of the error or of its cause, e.g. ECONNRESET */
    readonly code: string | null;
    readonly name: string;
    readonly message: string;
}

const TIMEOUT_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NETWORK_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_CLOSED',
]);
/** SDK error classes: OpenAI / Anthropic connection errors, DOMException timeouts, grammy */
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(['APIConnectionTimeoutError', 'TimeoutError']);
const NETWORK_NAMES: ReadonlySet<string> = new Set(['APIConnectionError', 'HttpError', 'FetchError']);

/** base-platform's own attempt timeout, the SDKs' "Request timed out." */
const TIMEOUT_MESSAGE = /^Timeout$|request timed out/i;
const NETWORK_MESSAGE = /fetch failed|socket hang up|connection error|network error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;
const RATE_LIMIT_MESSAGE = /\b429\b|rate.?limit|too many requests|RESOURCE_EXHAUSTED|exhausted|quota/i;
const CONTENT_FILTER_MESSAGE = /content.?filter|content.?policy|moderation|safety system/i;
const UPSTREAM_MESSAGE = /overloaded|\bUNAVAILABLE\b|internal server error|bad gateway|service unavailable|gateway time-?out/i;
const LOOSE_TIMEOUT_MESSAGE = /timed? ?out/i;

/** Error instances are plain objects to isJsonObject, so own fields read the same way */
const numberField = (value: unknown, key: string): number | null => {
    if (!isJsonObject(value)) return null;
    const field = value[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : null;
};

const stringField = (value: unknown, key: string): string | null => {
    if (!isJsonObject(value)) return null;
    const field = value[key];
    return typeof field === 'string' ? field : null;
};

const errorFactsOf = (error: unknown): ErrorFacts => {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    return {
        status: numberField(error, 'status') ?? numberField(error, 'statusCode'),
        appCode: error instanceof AppError ? error.code ?? null : null,
        code: stringField(error, 'code') ?? stringField(cause, 'code'),
        name: error instanceof Error ? error.name : '',
        message: error instanceof Error ? error.message : typeof error === 'string' ? error : '',
    };
};

const isTimeout = (facts: ErrorFacts): boolean =>
    TIMEOUT_NAMES.has(facts.name) ||
    (facts.code !== null && TIMEOUT_CODES.has(facts.code)) ||
    TIMEOUT_MESSAGE.test(facts.message);

const isNetwork = (facts: ErrorFacts): boolean =>
    NETWORK_NAMES.has(facts.name) ||
    (facts.code !== null && NETWORK_CODES.has(facts.code)) ||
    NETWORK_MESSAGE.test(facts.message);

export const classifyErrorKind = (error: unknown, options: ErrorKindOptions = {}): ErrorKind => {
    if (options.beforeRequest === true) return 'pre_request';
    return match(errorFactsOf(error))
        .returnType<ErrorKind>()
        .with({ status: 429 }, () => 'rate_limit')
        .with({ status: P.number.gte(500).lte(599) }, () => 'upstream')
        .with({ appCode: 'CONTENT_FILTER' }, () => 'content_filter')
        .with({ appCode: 'RATE_LIMIT' }, () => 'rate_limit')
        .with({ appCode: 'TIMEOUT' }, () => 'timeout')
        .with({ appCode: 'NETWORK' }, () => 'network')
        .when(isTimeout, () => 'timeout')
        .when(isNetwork, () => 'network')
        .when((facts) => RATE_LIMIT_MESSAGE.test(facts.message), () => 'rate_limit')
        .when((facts) => CONTENT_FILTER_MESSAGE.test(facts.message), () => 'content_filter')
        .when((facts) => UPSTREAM_MESSAGE.test(facts.message), () => 'upstream')
        .when((facts) => LOOSE_TIMEOUT_MESSAGE.test(facts.message), () => 'timeout')
        .otherwise(() => 'other');
};

export const ERROR_SUMMARY_MAX_CHARS = 200;

/** An error message cut to 200 characters (code points), whitespace collapsed */
export const summarizeErrorMessage = (message: string): string => {
    const collapsed = message.replace(/\s+/g, ' ').trim();
    const characters = Array.from(collapsed);
    if (characters.length <= ERROR_SUMMARY_MAX_CHARS) return collapsed;
    return `${characters.slice(0, ERROR_SUMMARY_MAX_CHARS - 1).join('')}…`;
};
