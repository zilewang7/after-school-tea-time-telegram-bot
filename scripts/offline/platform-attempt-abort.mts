/**
 * Offline cases for the attempts of sendWithRetry on the SDK chat paths, a
 * path for each call site: OpenAI Responses (plain, with an effort, after an
 * effort downgrade, the tool loop), Grok (round 1 and a tool-loop
 * continuation), DeepSeek and MiMo (plain and the tool loop) and Anthropic
 * Messages (plain and after a max_tokens downgrade). The OpenAI image path
 * shares the retry rules.
 *
 * - An attempt that runs out of time is aborted: the stub sees its connection
 *   close before the retry goes out, instead of the request streaming (and
 *   billing) next to its retry.
 * - The SDKs retry nothing on their own: a dropped connection and a 503 are
 *   retried by sendWithRetry alone, maxRetries requests in all, and a 429
 *   waits what its retry-after-ms asks for.
 * - A stop while a stream is open still closes its request.
 * - src/shared/errors.ts classifies what the SDKs used to retry on their own
 *   (connection errors, 408, 409, 429, x-should-retry: true) and reads their
 *   retry-after (capped at 30 s), checked on the SDKs' own error classes, so
 *   an SDK that renames them fails here.
 *
 * One local stub serves every path under a base path of its own (one per case
 * too), so the paths of a case run side by side and a request one case left
 * behind cannot land in the next. No network, no database.
 *
 * Run: npx tsx scripts/offline/platform-attempt-abort.mts
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    APIConnectionError as AnthropicConnectionError,
    APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
    APIError as AnthropicApiError,
    APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import {
    APIConnectionError as OpenAIConnectionError,
    APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
    APIError as OpenAIApiError,
    APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { match } from 'ts-pattern';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { quietly } from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';
import type { IAIPlatform, PlatformConfig, ThinkingEffortRequest, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler } from '../../src/ai/tools/index.js';

/** Short to keep the file fast, long enough for a request to reach the stub before it runs out */
const TIMEOUT_MS = 300;
/** A stream is stopped this long after its first event: the client has it by then, also on a busy machine */
const STOP_DELAY_MS = 300;
/**
 * A case whose replies still run after this has the stub end its open
 * answers: a stop that never reaches the request then fails the case instead
 * of holding the file until the SDK's own ten-minute timeout.
 */
const CASE_DEADLINE_MS = 10_000;
/** What a 'busy' 429 asks for in retry-after-ms; without it the retry would wait 5 s */
const BUSY_RETRY_AFTER_MS = 50;
/** The attempts the OpenAI image path gives itself (executeImageGeneration) */
const IMAGE_ATTEMPTS = 10;
const ANSWER = 'retry answered';
const PARTIAL = 'partial';

// ---- the stub ----

type Wire = 'responses' | 'chat' | 'messages';

/** What the stub does with one request */
type Step =
    /** A short complete stream */
    | 'answer'
    /** Nothing at all: only the client can end the request */
    | 'hang'
    /** A Grok round that calls lookup_weather, so the loop goes on */
    | 'tool-round'
    /** The socket is destroyed: no HTTP answer */
    | 'drop'
    /** 503 without retry-after */
    | 'unavailable'
    /** 429 that asks for a BUSY_RETRY_AFTER_MS wait */
    | 'busy'
    /** 503 that asks for a 1 ms wait */
    | 'briefly-unavailable'
    /** 400 that blames a level the request carried (see levelRejectionOf): a one-shot downgrade */
    | 'level-rejected'
    /** The stream starts with one event, then nothing more comes */
    | 'stream-then-hang';

interface SeenRequest {
    readonly arrivedAt: number;
    /** When the client closed the connection before the answer was complete */
    abandonedAt: number | null;
}

interface StubRun {
    readonly wire: Wire;
    readonly steps: readonly Step[];
    readonly seen: SeenRequest[];
    /** A 'stream-then-hang' step has written its first event */
    readonly onStreamStarted: () => void;
}

/** The current case's run of each base path */
const runs = new Map<string, StubRun>();
/** Answers left open on purpose; whatever the client did not end is ended after the case */
const openResponses = new Set<ServerResponse>();
/** Answers the stub itself ended: their close is not the client's doing */
const endedByStub = new WeakSet<ServerResponse>();

const endOpenResponses = (): void => {
    for (const response of openResponses) {
        endedByStub.add(response);
        response.destroy();
    }
    openResponses.clear();
};

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

const namedEvent = (event: Readonly<Record<string, unknown>>): string =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const dataEvent = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** Responses API (OpenAI, Grok) */
const responseObject = (id: string, output: readonly unknown[]) => ({
    id,
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'offline',
    output,
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 },
});
const outputTextDelta = (text: string) => ({
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: text,
});
const answerItem = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: ANSWER, annotations: [] }],
};
const weatherCall = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'lookup_weather',
    arguments: '{"city":"Oslo"}',
    status: 'completed',
};
const grokToolRound = (): string =>
    [
        { type: 'response.output_item.added', output_index: 0, item: { ...weatherCall, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: weatherCall.arguments },
        { type: 'response.output_item.done', output_index: 0, item: weatherCall },
        { type: 'response.completed', response: responseObject('resp_tools', [weatherCall]) },
    ]
        .map(namedEvent)
        .join('');

/** chat.completions (DeepSeek, MiMo) */
const chatChunk = (delta: Readonly<Record<string, unknown>>, finishReason: string | null = null) => ({
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'offline',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/** Anthropic Messages */
const messageStart = {
    type: 'message_start',
    message: {
        id: 'msg_offline',
        type: 'message',
        role: 'assistant',
        model: 'claude-offline',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
    },
};
const textBlockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textBlockDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

const answerOf = (wire: Wire): string =>
    match(wire)
        .with('responses', () =>
            [outputTextDelta(ANSWER), { type: 'response.completed', response: responseObject('resp_answer', [answerItem]) }]
                .map(namedEvent)
                .join('')
        )
        .with('chat', () => [chatChunk({ content: ANSWER }), chatChunk({}, 'stop')].map(dataEvent).join('') + 'data: [DONE]\n\n')
        .with('messages', () =>
            [
                messageStart,
                textBlockStart,
                textBlockDelta(ANSWER),
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
                { type: 'message_stop' },
            ]
                .map(namedEvent)
                .join('')
        )
        .exhaustive();

/** What a platform downgrades after, sending the round again within the same reply */
const levelRejectionOf = (wire: Wire): string =>
    match(wire)
        .with('responses', () => 'reasoning.effort high is not supported by this model')
        .with('chat', () => 'thinking is not supported by this model')
        .with('messages', () => 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens')
        .exhaustive();

const firstEventOf = (wire: Wire): string =>
    match(wire)
        .with('responses', () => namedEvent(outputTextDelta(PARTIAL)))
        .with('chat', () => dataEvent(chatChunk({ content: PARTIAL })))
        .with('messages', () => [messageStart, textBlockStart, textBlockDelta(PARTIAL)].map(namedEvent).join(''))
        .exhaustive();

const sendJsonError = (
    response: ServerResponse,
    status: number,
    message: string,
    headers: Readonly<Record<string, string>> = {}
): void => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify({ error: { message, type: 'offline_stub' } }));
};

const sendStream = (response: ServerResponse, body: string): void => {
    response.writeHead(200, SSE_HEADERS);
    response.end(body);
};

const play = (step: Step | undefined, run: StubRun, request: IncomingMessage, response: ServerResponse): void =>
    match(step)
        .with(undefined, () => sendJsonError(response, 400, 'a request the case did not expect'))
        .with('answer', () => sendStream(response, answerOf(run.wire)))
        .with('hang', () => {
            openResponses.add(response);
        })
        .with('tool-round', () => sendStream(response, grokToolRound()))
        .with('drop', () => {
            endedByStub.add(response);
            request.socket.destroy();
        })
        .with('unavailable', () => sendJsonError(response, 503, 'upstream overloaded'))
        .with('busy', () =>
            sendJsonError(response, 429, 'slow down', { 'retry-after-ms': String(BUSY_RETRY_AFTER_MS) })
        )
        .with('briefly-unavailable', () => sendJsonError(response, 503, 'upstream overloaded', { 'retry-after-ms': '1' }))
        .with('level-rejected', () => sendJsonError(response, 400, levelRejectionOf(run.wire)))
        .with('stream-then-hang', () => {
            openResponses.add(response);
            response.writeHead(200, SSE_HEADERS);
            response.write(firstEventOf(run.wire));
            run.onStreamStarted();
        })
        .exhaustive();

/** Every path's first segment names its run */
const route = (request: IncomingMessage, response: ServerResponse): void => {
    const prefix = new URL(request.url ?? '/', 'http://stub').pathname.split('/')[1] ?? '';
    const run = runs.get(prefix);
    if (run === undefined) {
        sendJsonError(response, 404, `no run for ${request.url ?? '?'}`);
        return;
    }
    const seen: SeenRequest = { arrivedAt: performance.now(), abandonedAt: null };
    const step = run.steps[run.seen.length];
    run.seen.push(seen);
    response.once('close', () => {
        openResponses.delete(response);
        if (!response.writableEnded && !endedByStub.has(response)) seen.abandonedAt = performance.now();
    });
    request.resume();
    request.once('end', () => play(step, run, request, response));
};

const stub = await startStubServer();
stub.handle(route);

// ---- the paths ----

// Read by the platform constructors, next to the base URL each path sets
for (const key of ['OPENAI_API_KEY', 'GROK_API_KEY', 'DEEPSEEK_API_KEY', 'MIMO_API_KEY', 'ANTHROPIC_API_KEY']) {
    process.env[key] = 'offline-stub';
}

const { OpenAIPlatform } = await import('../../src/ai/platforms/openai-platform.js');
const { GrokPlatform } = await import('../../src/ai/platforms/grok-platform.js');
const { DeepSeekPlatform } = await import('../../src/ai/platforms/deepseek-platform.js');
const { MimoPlatform } = await import('../../src/ai/platforms/mimo-platform.js');
const { AnthropicPlatform } = await import('../../src/ai/platforms/anthropic-platform.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');
const { getRetryWaitTime, isRetryableError } = await import('../../src/shared/errors.js');

/** The constructors read their base URL from the env */
const openAIAt = (baseUrl: string): IAIPlatform => {
    process.env.OPENAI_API_URL = `${baseUrl}/v1`;
    return new OpenAIPlatform();
};
const grokAt = (baseUrl: string): IAIPlatform => {
    process.env.GROK_API_URL = `${baseUrl}/v1`;
    return new GrokPlatform();
};
const deepSeekAt = (baseUrl: string): IAIPlatform => {
    process.env.DEEPSEEK_API_URL = `${baseUrl}/v1`;
    return new DeepSeekPlatform();
};
const mimoAt = (baseUrl: string): IAIPlatform => {
    process.env.MIMO_API_URL = `${baseUrl}/v1`;
    return new MimoPlatform();
};
const anthropicAt = (baseUrl: string): IAIPlatform => {
    // The SDK adds /v1/messages itself
    process.env.ANTHROPIC_API_URL = baseUrl;
    return new AnthropicPlatform();
};

/** One chat path: each sendWithRetry call site of the five platforms is behind one of these */
interface ChatPath {
    /** Its label in the assertions and part of its base path */
    readonly name: string;
    readonly wire: Wire;
    readonly model: string;
    readonly build: (baseUrl: string) => IAIPlatform;
    readonly withTools?: boolean;
    readonly thinkingEffort?: ThinkingEffortRequest;
    /** Steps before a case's own, e.g. the tool round a continuation follows */
    readonly leadingSteps?: readonly Step[];
}

const CHAT_PATHS: readonly ChatPath[] = [
    { name: 'openai', wire: 'responses', model: 'gpt-5.4', build: openAIAt },
    {
        name: 'openai-effort',
        wire: 'responses',
        model: 'gpt-5.4',
        build: openAIAt,
        thinkingEffort: { mode: 'explicit', value: 'high' },
    },
    {
        // The second sendWithRetry of openReasonedStream, after the effort was rejected
        name: 'openai-effort-downgrade',
        wire: 'responses',
        model: 'gpt-5.4',
        build: openAIAt,
        thinkingEffort: { mode: 'explicit', value: 'high' },
        leadingSteps: ['level-rejected'],
    },
    { name: 'openai-tool-loop', wire: 'responses', model: 'gpt-5.4', build: openAIAt, withTools: true },
    { name: 'grok', wire: 'responses', model: 'grok-4.7', build: grokAt },
    {
        name: 'grok-continuation',
        wire: 'responses',
        model: 'grok-4.7',
        build: grokAt,
        withTools: true,
        leadingSteps: ['tool-round'],
    },
    { name: 'deepseek', wire: 'chat', model: 'deepseek-flash', build: deepSeekAt },
    { name: 'deepseek-tool-loop', wire: 'chat', model: 'deepseek-flash', build: deepSeekAt, withTools: true },
    { name: 'mimo', wire: 'chat', model: 'mimo-v2.6-flash', build: mimoAt },
    { name: 'mimo-tool-loop', wire: 'chat', model: 'mimo-v2.6-flash', build: mimoAt, withTools: true },
    { name: 'anthropic', wire: 'messages', model: 'claude-sonnet-5-5', build: anthropicAt },
    {
        // openRoundStream's recursion after max_tokens was rejected
        name: 'anthropic-downgrade',
        wire: 'messages',
        model: 'claude-sonnet-5-5',
        build: anthropicAt,
        leadingSteps: ['level-rejected'],
    },
];

const weatherTool: ToolHandler = {
    definition: {
        name: 'lookup_weather',
        description: 'Look up the weather of a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    execute: async (args) => ({ content: `sunny in ${String(args.city)}`, isError: false, images: [], record: null }),
};

const question: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Oslo?' }] }];

// ---- running a case ----

interface CaseRun {
    /** The steps of each path after its leading steps */
    readonly steps: readonly Step[];
    readonly timeout: number;
    readonly maxRetries: number;
    /** Stop each reply STOP_DELAY_MS after its stream started */
    readonly stopWhenStreaming?: boolean;
}

/** A path as one case runs it: a platform of its own under a base path of its own */
interface Subject {
    readonly path: ChatPath;
    readonly prefix: string;
    readonly platform: IAIPlatform;
}

interface SubjectResult {
    readonly label: string;
    readonly text: string;
    readonly error: string | null;
    readonly endedAt: number;
    readonly seen: readonly SeenRequest[];
    /** The first request of the case's own steps */
    readonly firstOwn: number;
    /** When the case stopped the reply; null when it did not */
    readonly stoppedAt: number | null;
}

const configOf = ({ path }: Subject, caseRun: CaseRun, signal: AbortSignal): PlatformConfig => ({
    model: path.model,
    timeout: caseRun.timeout,
    maxRetries: caseRun.maxRetries,
    signal,
    ...(path.withTools === true ? { tools: createTurnTools([weatherTool]) } : {}),
    ...(path.thinkingEffort === undefined ? {} : { thinkingEffort: path.thinkingEffort }),
});

/** The reply's text, and the error that ended it instead of a clean end */
const drainReply = async (platform: IAIPlatform, config: PlatformConfig): Promise<{ text: string; error: string | null }> => {
    let text = '';
    try {
        for await (const chunk of await platform.sendMessage(question, config)) {
            if (chunk.type === 'text') text += chunk.content ?? '';
        }
        return { text, error: null };
    } catch (caught) {
        return { text, error: caught instanceof Error ? caught.message : String(caught) };
    }
};

const runSubject = async (subject: Subject, caseRun: CaseRun): Promise<SubjectResult> => {
    const controller = new AbortController();
    const stop: { at: number | null } = { at: null };
    const leadingSteps = subject.path.leadingSteps ?? [];
    const run: StubRun = {
        wire: subject.path.wire,
        steps: [...leadingSteps, ...caseRun.steps],
        seen: [],
        onStreamStarted: () => {
            if (caseRun.stopWhenStreaming !== true) return;
            setTimeout(() => {
                stop.at = performance.now();
                controller.abort();
            }, STOP_DELAY_MS);
        },
    };
    runs.set(subject.prefix, run);
    const { text, error } = await drainReply(subject.platform, configOf(subject, caseRun, controller.signal));
    return {
        label: subject.path.name,
        text,
        error,
        endedAt: performance.now(),
        seen: run.seen,
        firstOwn: leadingSteps.length,
        stoppedAt: stop.at,
    };
};

let casesRun = 0;

/**
 * Every path side by side, console output kept quiet. Each case builds its
 * platforms under base paths of its own, so a request an earlier case left
 * behind (a broken abort, an SDK retry) cannot land in this one.
 */
const runEveryPath = async (
    caseRun: CaseRun,
    check: (result: SubjectResult) => Promise<void> | void
): Promise<void> => {
    casesRun += 1;
    const casePrefix = `case${casesRun}`;
    const subjects = await quietly(async () =>
        CHAT_PATHS.map((path): Subject => {
            const prefix = `${casePrefix}-${path.name}`;
            return { path, prefix, platform: path.build(`${stub.url}/${prefix}`) };
        })
    );
    const deadline = setTimeout(endOpenResponses, CASE_DEADLINE_MS);
    try {
        const results = await quietly(() => Promise.all(subjects.map((subject) => runSubject(subject, caseRun))));
        clearTimeout(deadline);
        for (const result of results) await check(result);
    } finally {
        clearTimeout(deadline);
        endOpenResponses();
        runs.clear();
    }
};

/** Polls instead of sleeping: true as soon as the condition holds, false when it never does */
const becomesTrue = async (condition: () => boolean, withinMs: number): Promise<boolean> => {
    const deadline = performance.now() + withinMs;
    while (!condition()) {
        if (performance.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
};

/** When the stub saw request `index` closed early; null when it was not (or never came) */
const abandonedAtOf = (seen: readonly SeenRequest[], index: number): number | null => seen[index]?.abandonedAt ?? null;

/** The requests of the case's own steps, so far */
const ownRequestCount = ({ seen, firstOwn }: SubjectResult): number => seen.length - firstOwn;

const describeSeen = (seen: readonly SeenRequest[]): string =>
    JSON.stringify(
        seen.map((request) => ({
            arrivedAt: Math.round(request.arrivedAt),
            abandonedAt: request.abandonedAt === null ? null : Math.round(request.abandonedAt),
        }))
    );

// ---- the SDKs' own errors ----

/** What both SDKs build from an HTTP error answer */
const openAIHttpError = (status: number, headers: Record<string, string> = {}): Error =>
    OpenAIApiError.generate(status, { error: { message: `upstream said ${status}` } }, undefined, new Headers(headers));
const anthropicHttpError = (status: number, headers: Record<string, string> = {}): Error =>
    AnthropicApiError.generate(status, { error: { message: `upstream said ${status}` } }, undefined, new Headers(headers));

const networkCause = (): Error => new TypeError('fetch failed', { cause: new Error('other side closed') });

const cases: Array<{ name: string; body: () => void | Promise<void> }> = [
    {
        name: 'what the SDKs retried on their own is retryable here',
        body: () => {
            const retryable: Array<[string, unknown]> = [
                ['openai connection error', new OpenAIConnectionError({ cause: networkCause() })],
                ['openai connection timeout', new OpenAIConnectionTimeoutError()],
                ['anthropic connection error', new AnthropicConnectionError({ cause: networkCause() })],
                ['anthropic connection timeout', new AnthropicConnectionTimeoutError()],
                ['openai 408', openAIHttpError(408)],
                ['openai 409', openAIHttpError(409)],
                ['anthropic 408', anthropicHttpError(408)],
                ['anthropic 409', anthropicHttpError(409)],
                ['a 429 whose message has no 429', { status: 429, message: 'Too Many Requests' }],
                ['openai 400 with x-should-retry: true', openAIHttpError(400, { 'x-should-retry': 'true' })],
                ['anthropic 400 with x-should-retry: true', anthropicHttpError(400, { 'x-should-retry': 'true' })],
            ];
            for (const [label, error] of retryable) {
                expect(isRetryableError(error), `${label} is retried`);
            }
        },
    },
    {
        name: 'what was retryable stays so, and a stop or a request error is still final',
        body: () => {
            const stillRetryable: Array<[string, unknown]> = [
                ['our own attempt timeout', new Error('Timeout')],
                ['openai 429', openAIHttpError(429)],
                ['anthropic 529', anthropicHttpError(529)],
                ['openai 503 with x-should-retry: false', openAIHttpError(503, { 'x-should-retry': 'false' })],
                ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
            ];
            for (const [label, error] of stillRetryable) {
                expect(isRetryableError(error), `${label} is retried`);
            }
            const final: Array<[string, unknown]> = [
                ['openai user abort', new OpenAIUserAbortError()],
                ['anthropic user abort', new AnthropicUserAbortError()],
                ['openai 400', openAIHttpError(400)],
                ['anthropic 401', anthropicHttpError(401)],
                ['openai 404', openAIHttpError(404)],
                ['anthropic 413', anthropicHttpError(413)],
                ['openai 422', openAIHttpError(422)],
                ['a plain error that only reads like a connection error', new Error('Connection error.')],
            ];
            for (const [label, error] of final) {
                expect(!isRetryableError(error), `${label} is not retried`);
            }
        },
    },
    {
        name: 'a retry waits as long as the server asks, at most 30 s',
        body: () => {
            const waits: Array<[string, unknown, number]> = [
                ['retry-after-ms', openAIHttpError(429, { 'retry-after-ms': '250' }), 250],
                ['retry-after in seconds', anthropicHttpError(503, { 'retry-after': '2' }), 2000],
                ['a fraction of a second', openAIHttpError(429, { 'retry-after': '1.5' }), 1500],
                ['retry-after-ms before retry-after', anthropicHttpError(429, { 'retry-after-ms': '40', 'retry-after': '3' }), 40],
                ['two minutes, capped', openAIHttpError(429, { 'retry-after': '120' }), 30_000],
                ['45 s in ms, capped', anthropicHttpError(529, { 'retry-after-ms': '45000' }), 30_000],
                // Nothing usable asked for: the waits of before
                ['zero', openAIHttpError(429, { 'retry-after-ms': '0' }), 5000],
                ['unreadable', anthropicHttpError(503, { 'retry-after': 'soon' }), 2000],
                ['a date in the past', openAIHttpError(429, { 'retry-after': new Date(Date.now() - 60_000).toUTCString() }), 5000],
                ['a 429 without one', anthropicHttpError(429), 5000],
                ['a 503 without one', openAIHttpError(503), 2000],
                ['our own attempt timeout', new Error('Timeout'), 1000],
                ['a connection error', new OpenAIConnectionError({ cause: networkCause() }), 2000],
            ];
            for (const [label, error, expected] of waits) {
                const wait = getRetryWaitTime(error);
                expect(wait === expected, `${label}: waits ${expected} ms (got ${wait})`);
            }
            // An HTTP date carries whole seconds
            const dated = getRetryWaitTime(openAIHttpError(429, { 'retry-after': new Date(Date.now() + 10_000).toUTCString() }));
            expect(dated > 8000 && dated <= 10_000, `an HTTP date ten seconds ahead (got ${dated})`);
        },
    },
    {
        // Also warms every client up, so the timed cases below do not pay for a first connection
        name: 'every path answers through the stub',
        body: () =>
            runEveryPath({ steps: ['answer'], timeout: 20000, maxRetries: 1 }, (result) => {
                const { label, text, error } = result;
                expect(error === null && text.includes(ANSWER), `${label}: the answer streams (got ${JSON.stringify({ text, error })})`);
                expect(ownRequestCount(result) === 1, `${label}: one request (got ${ownRequestCount(result)})`);
            }),
    },
    {
        name: 'a timed-out attempt is given up before its retry, and the retry answers',
        body: () =>
            runEveryPath({ steps: ['hang', 'answer'], timeout: TIMEOUT_MS, maxRetries: 2 }, (result) => {
                const { label, text, error, seen, firstOwn } = result;
                expect(error === null && text.includes(ANSWER), `${label}: the retry answers (got ${JSON.stringify({ text, error })})`);
                expect(ownRequestCount(result) === 2, `${label}: the attempt and its retry, nothing else (got ${ownRequestCount(result)})`);
                // The retry waits a second after a timeout: closed before the
                // retry means closed at the deadline, not left to stream on
                const givenUpAt = abandonedAtOf(seen, firstOwn);
                const retryArrivedAt = seen[firstOwn + 1]?.arrivedAt ?? null;
                expect(
                    givenUpAt !== null && retryArrivedAt !== null && givenUpAt < retryArrivedAt,
                    `${label}: the timed-out request is closed before the retry goes out (got ${describeSeen(seen)})`
                );
            }),
    },
    {
        name: 'the last attempt that times out is given up as the reply fails',
        body: () =>
            runEveryPath({ steps: ['hang'], timeout: TIMEOUT_MS, maxRetries: 1 }, async (result) => {
                const { label, error, endedAt, seen, firstOwn } = result;
                expect(error === 'Timeout', `${label}: the reply fails with the timeout (got ${String(error)})`);
                expect(ownRequestCount(result) === 1, `${label}: a single request (got ${ownRequestCount(result)})`);
                const givenUp = await becomesTrue(() => abandonedAtOf(seen, firstOwn) !== null, 2000);
                expect(givenUp, `${label}: the timed-out request is closed (got ${describeSeen(seen)})`);
                const lateByMs = Math.round((abandonedAtOf(seen, firstOwn) ?? Infinity) - endedAt);
                expect(lateByMs < 1000, `${label}: as the reply fails (${lateByMs} ms after)`);
            }),
    },
    {
        name: 'a dropped connection is retried by sendWithRetry alone',
        body: () =>
            runEveryPath({ steps: ['drop', 'drop'], timeout: 20000, maxRetries: 2 }, (result) => {
                const { label, error } = result;
                expect(ownRequestCount(result) === 2, `${label}: maxRetries requests, none from the SDK (got ${ownRequestCount(result)})`);
                expect(error === 'Connection error.', `${label}: the SDK's connection error ends the reply (got ${String(error)})`);
            }),
    },
    {
        name: 'a 503 is retried by sendWithRetry alone',
        body: () =>
            runEveryPath({ steps: ['unavailable', 'unavailable'], timeout: 20000, maxRetries: 2 }, (result) => {
                const { label, error } = result;
                expect(ownRequestCount(result) === 2, `${label}: maxRetries requests, none from the SDK (got ${ownRequestCount(result)})`);
                expect(error?.startsWith('503 ') === true, `${label}: the 503 ends the reply (got ${String(error)})`);
            }),
    },
    {
        name: 'a 429 is retried after the wait the server asked for',
        body: () =>
            runEveryPath({ steps: ['busy', 'answer'], timeout: 20000, maxRetries: 2 }, (result) => {
                const { label, text, error, seen, firstOwn } = result;
                expect(ownRequestCount(result) === 2, `${label}: the 429 and its retry, none from the SDK (got ${ownRequestCount(result)})`);
                expect(error === null && text.includes(ANSWER), `${label}: the retry answers (got ${JSON.stringify({ text, error })})`);
                const waitedMs = Math.round((seen[firstOwn + 1]?.arrivedAt ?? Infinity) - (seen[firstOwn]?.arrivedAt ?? 0));
                expect(
                    waitedMs >= BUSY_RETRY_AFTER_MS && waitedMs < 2000,
                    `${label}: the retry waited the ${BUSY_RETRY_AFTER_MS} ms asked for, not the 5 s of a bare 429 (${waitedMs} ms)`
                );
            }),
    },
    {
        name: 'the OpenAI image path retries a 503 in sendWithRetry alone',
        body: async () => {
            const prefix = 'image-path';
            const run: StubRun = {
                wire: 'responses',
                steps: Array.from({ length: IMAGE_ATTEMPTS }, (): Step => 'briefly-unavailable'),
                seen: [],
                onStreamStarted: () => undefined,
            };
            runs.set(prefix, run);
            try {
                const outcome = await quietly(() => drainReply(openAIAt(`${stub.url}/${prefix}`), { model: 'gpt-image-2' }));
                expect(run.seen.length === IMAGE_ATTEMPTS, `${IMAGE_ATTEMPTS} attempts, none from the SDK (got ${run.seen.length})`);
                expect(outcome.error?.startsWith('503 ') === true, `the last 503 ends the reply (got ${String(outcome.error)})`);
            } finally {
                runs.clear();
            }
        },
    },
    {
        name: 'a stop while the stream is open closes its request',
        body: () =>
            runEveryPath({ steps: ['stream-then-hang'], timeout: 20000, maxRetries: 2, stopWhenStreaming: true }, async (result) => {
                const { label, text, error, seen, firstOwn, stoppedAt } = result;
                // What came before the stop is all the reply has: the stream was open, not still being opened
                expect(error === null && text === PARTIAL, `${label}: stopped after the first event (got ${JSON.stringify({ text, error })})`);
                const closed = await becomesTrue(() => abandonedAtOf(seen, firstOwn) !== null, 2000);
                expect(closed, `${label}: the stop closes the open stream (got ${describeSeen(seen)})`);
                expect(
                    (abandonedAtOf(seen, firstOwn) ?? -Infinity) >= (stoppedAt ?? Infinity),
                    `${label}: closed by the stop, not before it (got ${describeSeen(seen)}, stopped at ${Math.round(stoppedAt ?? -1)})`
                );
                expect(ownRequestCount(result) === 1, `${label}: nothing is sent after the stop (got ${ownRequestCount(result)})`);
            }),
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
await stub.close();
reportResults(results);
