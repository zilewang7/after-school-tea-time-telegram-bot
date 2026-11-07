/**
 * The API's request body limit.
 *
 * hono's own bodyLimit clones the request to hand the buffered body back to
 * the handler, and that clone throws under @hono/node-server: its Request is a
 * subclass whose private state Node's Request constructor cannot read, so a
 * body-less DELETE or a chunked upload became a 500 instead of reaching the
 * route. This reads the stream itself and rebuilds a plain Request from the URL
 * and init (never from the subclass instance), which works on Node 22 and 24.
 */
import type { Context, Env, MiddlewareHandler } from 'hono';

export interface BodyLimitOptions<TEnv extends Env> {
    maxSize: number;
    onTooLarge: (context: Context<TEnv>) => Response;
}

interface StreamRequestInit extends RequestInit {
    // Required by Node for a stream body; missing from the DOM typings
    duplex: 'half';
}

/** A content length that is not a number is treated as unknown */
const declaredLengthOf = (headers: Headers): number | null => {
    const raw = headers.get('content-length');
    if (raw === null) return null;
    const length = Number.parseInt(raw, 10);
    return Number.isFinite(length) ? length : null;
};

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });

export const createBodyLimit =
    <TEnv extends Env>({ maxSize, onTooLarge }: BodyLimitOptions<TEnv>): MiddlewareHandler<TEnv> =>
    async (context, next) => {
        const request = context.req.raw;
        if (request.body === null) return next();

        const declaredLength = declaredLengthOf(request.headers);
        const chunked = request.headers.has('transfer-encoding');
        // A declared length needs no buffering; an absent or chunked one is read below
        if (declaredLength !== null && !chunked) {
            return declaredLength > maxSize ? onTooLarge(context) : next();
        }

        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = request.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxSize) return onTooLarge(context);
            chunks.push(value);
        }

        const init: StreamRequestInit = {
            method: request.method,
            headers: request.headers,
            body: streamOf(chunks),
            duplex: 'half',
        };
        context.req.raw = new Request(request.url, init);
        return next();
    };
