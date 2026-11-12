/**
 * Fixtures for the offline cases of the Gemini tool loop's checkpoints and
 * resume: Vertex wire events and scripted rounds, a consumer that behaves
 * like the reply layer (it walks away at a chunk, or throws), a fake clock,
 * and value checks for checkpoints.
 *
 * Nothing from `src` is imported at runtime here (types only): a test file
 * imports the harness first and `src` after it.
 */
import type { StreamChunk } from '../../../src/ai/types.js';
import { sseReply, type ScriptedReply } from './fake-vertex.mts';

export const json = (value: unknown): string => JSON.stringify(value);

export const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// Vertex wire events
// ---------------------------------------------------------------------------

export const signature = (label: string): string => Buffer.from(`signature-${label}`).toString('base64');

export const USAGE = {
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 7,
    thoughtsTokenCount: 3,
    totalTokenCount: 110,
};

export interface EventOptions {
    readonly finishReason?: string;
    readonly grounding?: Record<string, unknown>;
}

/** One streamed chunk in Vertex wire shape; finishReason / grounding mark the last one */
export const event = (parts: readonly unknown[], options: EventOptions = {}) => ({
    candidates: [
        {
            content: { role: 'model', parts },
            ...(options.finishReason ? { finishReason: options.finishReason } : {}),
            ...(options.grounding ? { groundingMetadata: options.grounding } : {}),
        },
    ],
    ...(options.finishReason ? { usageMetadata: USAGE, modelVersion: 'offline-model' } : {}),
});

export const thoughtPart = (text: string) => ({ text, thought: true });
export const textPart = (text: string) => ({ text });
export const callPart = (name: string, args: Record<string, unknown>, label: string, id?: string) => ({
    functionCall: { ...(id ? { id } : {}), name, args },
    thoughtSignature: signature(label),
});

/** A round's chunks (one parts list each); the last one finishes the round */
export const roundEvents = (rounds: readonly unknown[][], options: EventOptions = {}): unknown[] =>
    rounds.map((parts, index) =>
        index === rounds.length - 1 ? event(parts, { finishReason: 'STOP', ...options }) : event(parts)
    );

export const answer = (text: string, options: EventOptions = {}): ScriptedReply =>
    sseReply(roundEvents([[thoughtPart(`thinking before ${text}`)], [textPart(text)]], options));

export interface ScriptedCall {
    readonly name: string;
    readonly args?: Record<string, unknown>;
}

/**
 * A round that thinks, says a line, then makes these calls (in one chunk,
 * each with its own signature `<label>-<index>` and id `call_<label>_<index>`)
 */
export const callsRound = (
    label: string,
    calls: readonly ScriptedCall[],
    options: EventOptions & { readonly text?: string } = {}
): ScriptedReply =>
    sseReply(
        roundEvents(
            [
                [thoughtPart(`plan ${label}`)],
                ...(options.text === undefined ? [] : [[textPart(options.text)]]),
                calls.map((call, index) =>
                    callPart(call.name, call.args ?? { topic: label }, `${label}-${index}`, `call_${label}_${index}`)
                ),
            ],
            options
        )
    );

export const groundingOf = (queries: string[], uris: string[]) => ({
    webSearchQueries: queries,
    groundingChunks: uris.map((uri) => ({ web: { uri, title: `title of ${uri}` } })),
});

// ---------------------------------------------------------------------------
// Consuming a reply
// ---------------------------------------------------------------------------

export interface ConsumeOptions {
    /** Sees every chunk as it arrives; a throw here is a consumer error */
    readonly onChunk?: (chunk: StreamChunk) => void;
    /** Walks away right after this chunk */
    readonly breakAfter?: (chunk: StreamChunk) => boolean;
    /** Like the reply layer: once this signal fired, it walks away at the next chunk */
    readonly stopSignal?: AbortSignal;
}

export interface ConsumedReply {
    readonly chunks: StreamChunk[];
    /** Console output while the reply ran */
    readonly lines: string[];
    /** What sendMessage or the stream threw, or null */
    readonly error: unknown;
}

const lineOf = (args: readonly unknown[]): string =>
    args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : json(arg))).join(' ');

/** Starts a reply and reads it the way `options` says, console captured; a throw is returned */
export const consumeReply = async (
    send: () => Promise<AsyncIterable<StreamChunk>>,
    options: ConsumeOptions = {}
): Promise<ConsumedReply> => {
    const lines: string[] = [];
    const chunks: StreamChunk[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(lineOf(args));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    let error: unknown = null;
    try {
        const stream = await send();
        for await (const chunk of stream) {
            if (options.stopSignal?.aborted) break;
            chunks.push(chunk);
            options.onChunk?.(chunk);
            if (options.breakAfter?.(chunk) === true) break;
        }
    } catch (caught) {
        error = caught;
    } finally {
        Object.assign(console, original);
    }
    return { chunks, lines, error };
};

export const textOf = (chunks: readonly StreamChunk[], type: 'text' | 'thinking' = 'text'): string =>
    chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => chunk.content ?? '')
        .join('');

export const statusTexts = (chunks: readonly StreamChunk[]): string[] =>
    chunks.filter((chunk) => chunk.type === 'status').map((chunk) => chunk.status?.text ?? '(clear)');

export const usageLines = (lines: readonly string[]): string[] =>
    lines.filter((line) => line.startsWith('[gemini-usage]') && !line.includes(' summary '));

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Runs `body` with Date.now under the test's control; `jump` moves it forward */
export const withFakeClock = async (body: (jump: (milliseconds: number) => void) => Promise<void>): Promise<void> => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    Date.now = () => realNow() + offsetMs;
    try {
        await body((milliseconds) => {
            offsetMs += milliseconds;
        });
    } finally {
        Date.now = realNow;
    }
};

// ---------------------------------------------------------------------------
// Checkpoints as values
// ---------------------------------------------------------------------------

/** A deep copy of a value as text (Buffers by content), to compare it with itself later */
export const frozenCopyOf = (value: unknown): string => JSON.stringify(value);

const isPlainObject = (value: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

/**
 * Where a value holds something other than plain data (objects, arrays,
 * strings, numbers, booleans, null/undefined, Buffers): a function, a class
 * instance such as a signal or a stream, a symbol. Empty when it is all data.
 */
export const nonPlainPaths = (value: unknown, path = '$', seen = new Set<object>()): string[] => {
    if (value === null || value === undefined) return [];
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return [];
    if (typeof value !== 'object') return [`${path} (${kind})`];
    if (Buffer.isBuffer(value) || seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) {
        return value.flatMap((item, index) => nonPlainPaths(item, `${path}[${index}]`, seen));
    }
    if (!isPlainObject(value)) return [`${path} (${value.constructor.name})`];
    return Object.entries(value).flatMap(([key, item]) => nonPlainPaths(item, `${path}.${key}`, seen));
};
