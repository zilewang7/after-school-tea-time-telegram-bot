import { recordServerDate } from './server-clock';
import type { ApiErrorCode } from './types';

export type ApiFailure =
    // fetch rejected or the body was cut off: a write may or may not have reached the bot
    | { kind: 'network' }
    // The proxy answered for a bot that is down or restarting; serverMessage is set when the bot itself sent a JSON 503
    | { kind: 'unreachable'; status: number; serverMessage: string | null }
    // The bot answered with an error status; code and message come from { error: { code, message } }.
    // retryAfterSeconds comes from Retry-After (429), null when absent.
    | { kind: 'http'; status: number; code: ApiErrorCode | null; message: string | null; retryAfterSeconds: number | null };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

/** A file download: the body as text plus what the server named it */
export type TextResult =
    | { ok: true; text: string; fileName: string | null; contentType: string | null }
    | { ok: false; failure: ApiFailure };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
    method: HttpMethod;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
}

export type Requester = <T>(options: RequestOptions) => Promise<ApiResult<T>>;
export type TextRequester = (options: RequestOptions) => Promise<TextResult>;

// 502/503 from Traefik while the bot restarts; 52x/530 from Cloudflare when the origin is down
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 520, 521, 522, 523, 530]);

const API_ERROR_CODES: readonly ApiErrorCode[] = [
    'invalid',
    'unauthorized',
    'forbidden',
    'locked',
    'not_found',
    'conflict',
    'too_large',
    'rate_limited',
    'internal',
    'timeout',
];

const toApiErrorCode = (code: string): ApiErrorCode | null =>
    API_ERROR_CODES.find((knownCode) => knownCode === code) ?? null;

interface ParsedErrorBody {
    code: ApiErrorCode | null;
    message: string | null;
}

const readErrorBody = async (response: Response): Promise<ParsedErrorBody | null> => {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return null;
    }
    if (typeof body !== 'object' || body === null || !('error' in body)) return null;
    const error: unknown = body.error;
    if (typeof error !== 'object' || error === null) return null;
    const code = 'code' in error && typeof error.code === 'string' ? toApiErrorCode(error.code) : null;
    const message = 'message' in error && typeof error.message === 'string' && error.message !== '' ? error.message : null;
    return { code, message };
};

const DELAY_SECONDS_PATTERN = /^\d{1,7}$/;

// The panel API sends Retry-After as delay seconds; the HTTP-date form is not used
const retryAfterSecondsOf = (header: string | null): number | null => {
    const value = header?.trim() ?? '';
    return DELAY_SECONDS_PATTERN.test(value) ? Number(value) : null;
};

const toFailure = async (response: Response): Promise<ApiFailure> => {
    const errorBody = await readErrorBody(response);
    if (UNREACHABLE_STATUSES.has(response.status)) {
        return { kind: 'unreachable', status: response.status, serverMessage: errorBody?.message ?? null };
    }
    return {
        kind: 'http',
        status: response.status,
        code: errorBody?.code ?? null,
        message: errorBody?.message ?? null,
        retryAfterSeconds: retryAfterSecondsOf(response.headers.get('Retry-After')),
    };
};

const requestHeaders = (initData: string, body: unknown, accept: string): Record<string, string> => {
    const headers: Record<string, string> = { Accept: accept };
    // initData only ever travels in this header, never in the URL; the public API has none
    if (initData !== '') headers['X-Init-Data'] = initData;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return headers;
};

/** fetch with the panel's headers; null when the request never got an answer */
const send = async (
    initData: string,
    { method, path, body, signal }: RequestOptions,
    accept: string
): Promise<Response | null> => {
    try {
        return await fetch(path, {
            method,
            headers: requestHeaders(initData, body, accept),
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: 'no-store',
            signal,
        });
    } catch {
        return null;
    }
};

/** A JSON body; a cut-off or unparsable body is a network failure, as it may be half a write */
export const createRequester = (initData: string): Requester => {
    const request = async <T>(options: RequestOptions): Promise<ApiResult<T>> => {
        const response = await send(initData, options, 'application/json');
        if (response === null) return { ok: false, failure: { kind: 'network' } };
        recordServerDate(response.headers.get('Date'));
        if (!response.ok) return { ok: false, failure: await toFailure(response) };
        try {
            const data: T = await response.json();
            return { ok: true, data };
        } catch {
            return { ok: false, failure: { kind: 'network' } };
        }
    };
    return request;
};

/**
 * A JSON requester without initData: the public share API takes the token in
 * the path as its permission, so the read-only page works for someone who is
 * not in the chat (and needs no signed session at all).
 */
export const createPublicRequester = (): Requester => createRequester('');

const FILE_NAME_PATTERN = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i;

/** The name of a downloaded file: `filename*=UTF-8''…` first, then the plain `filename` */
const fileNameOf = (header: string | null): string | null => {
    if (header === null) return null;
    const matched = FILE_NAME_PATTERN.exec(header);
    const encoded = matched?.[1];
    const plain = matched?.[2];
    if (encoded !== undefined) {
        try {
            return decodeURIComponent(encoded);
        } catch {
            return encoded;
        }
    }
    return plain ?? null;
};

/**
 * A download (the conversation export): the body as text. The server answers
 * with an attachment, so the name and type come from its headers.
 */
export const createTextRequester = (initData: string): TextRequester => {
    const request = async (options: RequestOptions): Promise<TextResult> => {
        const response = await send(initData, options, 'text/markdown, application/json;q=0.9, */*;q=0.8');
        if (response === null) return { ok: false, failure: { kind: 'network' } };
        recordServerDate(response.headers.get('Date'));
        if (!response.ok) return { ok: false, failure: await toFailure(response) };
        try {
            return {
                ok: true,
                text: await response.text(),
                fileName: fileNameOf(response.headers.get('Content-Disposition')),
                contentType: response.headers.get('Content-Type'),
            };
        } catch {
            return { ok: false, failure: { kind: 'network' } };
        }
    };
    return request;
};
