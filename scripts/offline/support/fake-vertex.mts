/**
 * A fake Vertex endpoint for the Gemini platform: a real Vertex-mode
 * GoogleGenAI client whose fetch records every request (body, headers,
 * signal) and replays scripted replies. The SDK's request and response
 * converters stay in the path, as in production.
 *
 * Besides whole SSE bodies, a reply can stream its body in separate reads,
 * then fail: a bare `{"error":…}` JSON read makes the SDK throw the same
 * ApiError production sees mid-stream ("got status: RESOURCE_EXHAUSTED"),
 * and `failWith` errors the body the way undici does when a connection drops.
 */
import { GoogleGenAI } from '@google/genai';

export interface ScriptedReply {
    readonly status: number;
    readonly contentType: string;
    /** The whole body in one read */
    readonly body: string;
    /** Or the body in separate reads, in order */
    readonly pieces?: readonly string[];
    /** After the pieces, the body errors with this instead of ending */
    readonly failWith?: () => unknown;
    /** After the pieces, the body stays open until the request's signal aborts */
    readonly hangAfterPieces?: boolean;
    /** fetch itself rejects with this (the request never got a response) */
    readonly fetchError?: () => unknown;
    /** Never answers: the promise rejects only when the request's signal aborts */
    readonly hangUntilAborted?: boolean;
    /** Runs when the reply is served (e.g. to move a fake clock) */
    readonly onServe?: () => void;
}

export interface RecordedRequest {
    readonly url: string;
    /** The body exactly as sent, for byte-identity checks */
    readonly rawBody: string;
    readonly body: Record<string, unknown>;
    /** Request headers, names lower-cased; credentials are never kept */
    readonly headers: Readonly<Record<string, string>>;
    /** The attempt's abort signal, as the SDK handed it to fetch */
    readonly signal: AbortSignal | null;
    /** Epoch ms when fetch was called, and when the signal aborted (null: never) */
    readonly sentAt: number;
    readonly abortedAt: () => number | null;
}

export interface FakeVertex {
    readonly client: GoogleGenAI;
    readonly requests: RecordedRequest[];
    /** Replaces the queue of replies and forgets the recorded requests */
    reset(replies: readonly ScriptedReply[]): void;
    /** Replies not served yet */
    pending(): number;
}

const CREDENTIAL_HEADER = /authorization|api-key|goog-api-key|cookie/i;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
        if (!CREDENTIAL_HEADER.test(name)) headers[name.toLowerCase()] = value;
    });
    return headers;
};

const abortReason = (signal: AbortSignal | null): unknown => {
    if (signal?.reason !== undefined) return signal.reason;
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
};

/** A body read piece by piece, then ended, errored, or held open until the abort */
const piecewiseBody = (reply: ScriptedReply, signal: AbortSignal | null): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    const pieces = reply.pieces ?? [];
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const piece = pieces[index];
            index += 1;
            if (piece !== undefined) {
                controller.enqueue(encoder.encode(piece));
                return;
            }
            if (reply.failWith) {
                controller.error(reply.failWith());
                return;
            }
            if (reply.hangAfterPieces) {
                return new Promise<void>((resolve) => {
                    const fail = (): void => {
                        controller.error(abortReason(signal));
                        resolve();
                    };
                    if (signal?.aborted) fail();
                    else signal?.addEventListener('abort', fail, { once: true });
                });
            }
            controller.close();
        },
    });
};

export const UNEXPECTED_REQUEST_REPLY: ScriptedReply = {
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 400, message: 'unexpected request', status: 'INVALID_ARGUMENT' } }),
};

export const createFakeVertex = (): FakeVertex => {
    const replies: ScriptedReply[] = [];
    const requests: RecordedRequest[] = [];

    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const rawBody = typeof init?.body === 'string' ? init.body : '{}';
        const signal = init?.signal ?? null;
        let abortedAt: number | null = null;
        signal?.addEventListener(
            'abort',
            () => {
                abortedAt = Date.now();
            },
            { once: true }
        );
        requests.push({
            url: String(input),
            rawBody,
            body: asRecord(JSON.parse(rawBody)),
            headers: headersOf(init),
            signal,
            sentAt: Date.now(),
            abortedAt: () => abortedAt,
        });
        const reply = replies.shift() ?? UNEXPECTED_REQUEST_REPLY;
        reply.onServe?.();
        if (reply.fetchError) throw reply.fetchError();
        if (reply.hangUntilAborted) {
            return new Promise<Response>((_resolve, reject) => {
                const abort = (): void => reject(abortReason(signal));
                if (!signal) return;
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
            });
        }
        const body = reply.pieces ? piecewiseBody(reply, signal) : reply.body;
        return new Response(body, { status: reply.status, headers: { 'content-type': reply.contentType } });
    };

    return {
        client: new GoogleGenAI({
            vertexai: true,
            project: 'test',
            location: 'global',
            // An api key and project id keep google-auth-library off ADC and the metadata server
            googleAuthOptions: { apiKey: 'offline', projectId: 'test' },
            httpOptions: { fetch: fakeFetch },
        }),
        requests,
        reset: (next) => {
            replies.length = 0;
            replies.push(...next);
            requests.length = 0;
        },
        pending: () => replies.length,
    };
};

/** One SSE `data:` line */
export const sseLine = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

/** A whole SSE body in one read */
export const sseReply = (events: readonly unknown[], onServe?: () => void): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: events.map(sseLine).join(''),
    ...(onServe ? { onServe } : {}),
});

/** The Vertex error body for a status, as a JSON value */
export const vertexError = (code: number, message: string): unknown => ({
    error: {
        code,
        message,
        status: code === 429 ? 'RESOURCE_EXHAUSTED' : code === 400 ? 'INVALID_ARGUMENT' : code >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION',
    },
});

/** The request is refused before any stream opens */
export const httpErrorReply = (code: number, message: string, onServe?: () => void): ScriptedReply => ({
    status: code,
    contentType: 'application/json',
    body: JSON.stringify(vertexError(code, message)),
    ...(onServe ? { onServe } : {}),
});

/**
 * HTTP 200, these events, then a bare error JSON in its own read: the SDK
 * throws ApiError(code) after yielding the events, as in production
 */
export const midStreamErrorReply = (events: readonly unknown[], code: number, message: string): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: '',
    pieces: [...events.map(sseLine), JSON.stringify(vertexError(code, message))],
});

/** HTTP 200, these events, then the body errors the way a dropped connection does */
export const droppedStreamReply = (events: readonly unknown[], failWith: () => unknown): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: '',
    pieces: events.map(sseLine),
    failWith,
});

/** HTTP 200, these events, then the body stays open until the request is aborted */
export const stalledStreamReply = (events: readonly unknown[]): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: '',
    pieces: events.map(sseLine),
    hangAfterPieces: true,
});
