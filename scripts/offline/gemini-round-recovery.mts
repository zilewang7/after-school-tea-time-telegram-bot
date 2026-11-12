/**
 * Offline cases for the in-round automatic recovery of the Gemini client
 * tool loop (design 2026-1112-1123 §5, test plan §11 cases 1-13, 16, 17).
 *
 * The platform runs a real Vertex-mode SDK client over a fake fetch
 * (support/fake-vertex.mts). A failure in the middle of a stream is a body
 * that delivers some SSE events and then a bare `{"error":…}` JSON, which is
 * what makes the SDK throw production's mid-stream ApiError. The platform is
 * a subclass whose `sleep` records each wait and returns at once, and whose
 * jitter is pinned, so the waits read as the policy's base values.
 *
 * Run: npx tsx scripts/offline/gemini-round-recovery.mts
 */
import { getEventListeners } from 'node:events';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    createFakeVertex,
    droppedStreamReply,
    httpErrorReply,
    midStreamErrorReply,
    sseReply,
    stalledStreamReply,
    type RecordedRequest,
    type ScriptedReply,
} from './support/fake-vertex.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult, TurnTools } from '../../src/ai/tools/index.js';

// Gemini client tools on, whatever the shell says (read lazily by the platform)
delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools, TOOL_LOOP_DEADLINE_MS, FREE_TOOL_ROUNDS_MAX } = await import('../../src/ai/tools/index.js');
const { createUsageSink } = await import('../../src/ai/usage/index.js');

type UsageSink = import('../../src/ai/usage/index.js').UsageSink;

const vertex = createFakeVertex();

/** Records every wait and returns at once; `onSleep` may press stop meanwhile */
class RecordingGeminiPlatform extends GeminiPlatform {
    readonly sleeps: number[] = [];
    onSleep: ((ms: number) => void) | null = null;

    protected override sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.sleeps.push(ms);
        this.onSleep?.(ms);
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}

// random 0.5: no jitter, every wait is the ladder's base value
const platform = new RecordingGeminiPlatform({ client: vertex.client, random: () => 0.5 });

/** Waits through the platform's own sleep, one millisecond each */
class ShortWaitGeminiPlatform extends GeminiPlatform {
    protected override sleep(_ms: number, signal?: AbortSignal): Promise<void> {
        return super.sleep(1, signal);
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const signature = (label: string): string => Buffer.from(`signature-${label}`).toString('base64');

interface EventOptions {
    readonly finishReason?: string;
    readonly grounding?: Record<string, unknown>;
}

const USAGE = { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 110 };

/** One streamed chunk in Vertex wire shape; finishReason / grounding mark the last one */
const event = (parts: readonly unknown[], options: EventOptions = {}) => ({
    candidates: [
        {
            content: { role: 'model', parts },
            ...(options.finishReason ? { finishReason: options.finishReason } : {}),
            ...(options.grounding ? { groundingMetadata: options.grounding } : {}),
        },
    ],
    ...(options.finishReason ? { usageMetadata: USAGE, modelVersion: 'offline-model' } : {}),
});

const thoughtPart = (text: string) => ({ text, thought: true });
const textPart = (text: string) => ({ text });
const signedEmptyText = (label: string) => ({ text: '', thoughtSignature: signature(label) });
const imagePart = () => ({ inlineData: { mimeType: 'image/png', data: Buffer.from('partial image').toString('base64') } });
const callPart = (name: string, args: Record<string, unknown>, label: string, id?: string) => ({
    functionCall: { ...(id ? { id } : {}), name, args },
    thoughtSignature: signature(label),
});

/** A round's chunks (one parts list each); the last one finishes the round */
const roundEvents = (rounds: readonly unknown[][], options: EventOptions = {}): unknown[] =>
    rounds.map((parts, index) =>
        index === rounds.length - 1 ? event(parts, { finishReason: 'STOP', ...options }) : event(parts)
    );

const answer = (text: string, options: EventOptions = {}): ScriptedReply =>
    sseReply(roundEvents([[thoughtPart(`thinking before ${text}`)], [textPart(text)]], options));

const callRound = (name: string, args: Record<string, unknown>, label: string): ScriptedReply =>
    sseReply(roundEvents([[thoughtPart(`plan ${label}`)], [callPart(name, args, label, `call_${label}`), textPart('')]]));

const groundingOf = (queries: string[], uris: string[]) => ({
    webSearchQueries: queries,
    groundingChunks: uris.map((uri) => ({ web: { uri, title: `title of ${uri}` } })),
});

const RATE_LIMITED = 'Resource exhausted. Please try again later.';
const INTERNAL = 'Internal error encountered.';

// ---- fake tools ----

const executions: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
let afterToolExecution: (() => void) | null = null;

const okResult = (content: string): ToolResult => ({ content, isError: false, images: [], record: null });

const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties });

const recordingTool = (name: string, content: string): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: objectSchema({ topic: { type: 'string' } }) },
    execute: async (args) => {
        executions.push({ name, args });
        afterToolExecution?.();
        return okResult(content);
    },
});

const lookupA = recordingTool('lookup_a', 'key is K-7731');
const lookupB = recordingTool('lookup_b', 'code word is AZALEA-42');
const sendFile = recordingTool('send_file', 'file sent');
const turnTools = createTurnTools([lookupA, lookupB]);
const turnToolsWithFree = createTurnTools([lookupA, lookupB, sendFile]);

// ---- helpers ----

const reset = (replies: readonly ScriptedReply[]): void => {
    vertex.reset(replies);
    executions.length = 0;
    platform.sleeps.length = 0;
    platform.onSleep = null;
    afterToolExecution = null;
};

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

interface TurnOptions {
    readonly tools?: TurnTools;
    readonly messages?: UnifiedMessage[];
    readonly signal?: AbortSignal;
    readonly maxRetries?: number;
    readonly timeout?: number;
    readonly usageSink?: UsageSink;
    /** Called with every chunk as it arrives */
    readonly onChunk?: (chunk: StreamChunk) => void;
    /** Another platform over the same fake Vertex */
    readonly platform?: InstanceType<typeof GeminiPlatform>;
}

interface TurnResult {
    readonly chunks: StreamChunk[];
    readonly lines: string[];
    readonly error: unknown;
}

/** One reply, console captured; a thrown error is returned, not raised */
const runTurn = async (options: TurnOptions = {}): Promise<TurnResult> => {
    const lines: string[] = [];
    const chunks: StreamChunk[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : json(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    let error: unknown = null;
    try {
        const stream = await (options.platform ?? platform).sendMessage(options.messages ?? userTurn('What is the code word?'), {
            model: 'gemini-3.8-flash',
            systemPrompt: 'offline system prompt',
            // Recovery is on unless a case asks for the single attempt
            maxRetries: options.maxRetries ?? 3,
            tools: options.tools ?? turnTools,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.usageSink ? { usageSink: options.usageSink } : {}),
        });
        for await (const chunk of stream) {
            chunks.push(chunk);
            options.onChunk?.(chunk);
        }
    } catch (caught) {
        error = caught;
    } finally {
        Object.assign(console, original);
    }
    return { chunks, lines, error };
};

const textOf = (chunks: readonly StreamChunk[], type: 'text' | 'thinking' = 'text'): string =>
    chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => chunk.content ?? '')
        .join('');

const statusTexts = (chunks: readonly StreamChunk[]): string[] =>
    chunks.filter((chunk) => chunk.type === 'status').map((chunk) => chunk.status?.text ?? '(clear)');

const recoverLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[gemini-recover]'));
const usageLines = (lines: readonly string[]): string[] =>
    lines.filter((line) => line.startsWith('[gemini-usage]') && !line.includes(' summary '));
const failedUsageLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[gemini-usage-failed]'));

const marker = (round: number): string => `\n\n〔第 ${round} 轮生成中断，已自动重试，以下为重新生成的思考〕\n\n`;

const hasAudio = (request: RecordedRequest | undefined): boolean => (request?.rawBody ?? '').includes('audio/ogg');

const declarationCount = (request: RecordedRequest | undefined): number =>
    asArray(request?.body.tools)
        .map(asRecord)
        .flatMap((tool) => asArray(tool.functionDeclarations)).length;

const isModeNone = (request: RecordedRequest | undefined): boolean =>
    asRecord(asRecord(request?.body.toolConfig).functionCallingConfig).mode === 'NONE';

const errorStatus = (error: unknown): unknown => asRecord(error).status;
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs `body` with Date.now under the test's control; `jump` moves it forward */
const withFakeClock = async (body: (jump: (milliseconds: number) => void) => Promise<void>): Promise<void> => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    Date.now = () => realNow() + offsetMs;
    try {
        await body((milliseconds) => {
            offsetMs += milliseconds;
        });
    } finally {
        Date.now = realNow;
        afterToolExecution = null;
    }
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: '1. round 1 breaks mid-stream (429) after thinking: same request again, both thoughts kept with a marker between',
        body: async () => {
            reset([
                midStreamErrorReply([event([thoughtPart('first thoughts')])], 429, RATE_LIMITED),
                sseReply(roundEvents([[thoughtPart('second thoughts')], [textPart('The answer.')], [signedEmptyText('a1')]])),
            ]);
            const usageSink = createUsageSink();

            const { chunks, lines, error } = await runTurn({ usageSink });

            expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
            expect(vertex.requests.length === 2, `two requests (got ${vertex.requests.length})`);
            expect(vertex.requests[0]?.rawBody === vertex.requests[1]?.rawBody, 'the retry is byte for byte the failed request');
            expect(
                textOf(chunks, 'thinking') === `first thoughts${marker(1)}second thoughts`,
                `the shown thinking stays, the marker, then the retry's (got ${json(textOf(chunks, 'thinking'))})`
            );
            expect(textOf(chunks) === 'The answer.', 'the answer streams');
            expect(
                json(statusTexts(chunks)) === json(['⟳ 第 1 轮被限流（429），15 秒后第 2 次尝试', '⟳ 第 1 轮重试中（第 2 次尝试）', '(clear)']),
                `waiting, retrying, then cleared once the stream opened (got ${json(statusTexts(chunks))})`
            );
            const types = chunks.map((chunk) => chunk.type);
            const clearIndex = chunks.findIndex((chunk) => chunk.type === 'status' && chunk.status === undefined);
            const markerIndex = chunks.findIndex((chunk) => chunk.content === marker(1));
            expect(clearIndex >= 0 && markerIndex === clearIndex + 1, `the marker comes right before the retry's first chunk (got ${json(types)})`);
            expect(json(platform.sleeps) === '[15000]', `one 15 s wait (got ${json(platform.sleeps)})`);
            const totals = usageSink.totals();
            expect(totals.rounds === 1 && totals.roundRetries === 1, `one round, one automatic retry (got ${json(totals)})`);
            expect(totals.promptTokens === 100, 'only the finished attempt is billed into the sink');
            expect(
                json(recoverLines(lines)) === json(['[gemini-recover] round=1 phase=stream kind=rate_limit attempt=1 wait=15000ms']),
                `the retry is logged (got ${json(recoverLines(lines))})`
            );
        },
    },
    {
        name: '2. no marker: a failed opening, and a broken stream that had shown no thinking',
        body: async () => {
            reset([httpErrorReply(429, RATE_LIMITED), answer('Opened second time.')]);
            const opened = await runTurn();
            expect(opened.error === null && vertex.requests.length === 2, 'a failed opening is retried');
            expect(!textOf(opened.chunks, 'thinking').includes('〔'), 'no marker after a failed opening');
            expect(
                json(statusTexts(opened.chunks)) ===
                    json(['⟳ 第 1 轮被限流（429），15 秒后第 2 次尝试', '⟳ 第 1 轮重试中（第 2 次尝试）', '(clear)']),
                `the status lines (got ${json(statusTexts(opened.chunks))})`
            );
            expect(opened.chunks[0]?.type === 'status', 'the first chunk is the status line, never a marker');

            reset([midStreamErrorReply([event([signedEmptyText('quiet')])], 500, INTERNAL), answer('After a quiet break.')]);
            const quiet = await runTurn();
            expect(quiet.error === null && vertex.requests.length === 2, 'a broken stream that showed nothing is retried');
            expect(
                textOf(quiet.chunks, 'thinking') === 'thinking before After a quiet break.',
                `no marker: nothing was shown before the break (got ${json(textOf(quiet.chunks, 'thinking'))})`
            );
            expect(json(platform.sleeps) === '[5000]', '5xx waits 5 s');
        },
    },
    {
        name: '3. a later round breaks with 500: tools ran once, the resent request carries the same signatures',
        body: async () => {
            reset([
                callRound('lookup_a', { topic: 'falcon' }, 'r1'),
                midStreamErrorReply([event([thoughtPart('round 2 thinking')])], 500, INTERNAL),
                answer('The code word is AZALEA-42.'),
            ]);

            const { chunks, error, lines } = await runTurn();

            expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
            expect(vertex.requests.length === 3, `three requests (got ${vertex.requests.length})`);
            expect(json(executions.map((execution) => execution.name)) === '["lookup_a"]', `the tool ran once (got ${json(executions)})`);
            expect(vertex.requests[1]?.rawBody === vertex.requests[2]?.rawBody, 'round 2 is resent byte for byte');
            expect(
                (vertex.requests[2]?.rawBody ?? '').includes(signature('r1')),
                "round 1's signature is replayed in the resend"
            );
            expect(textOf(chunks, 'thinking').includes(marker(2)), 'the marker names round 2');
            expect(statusTexts(chunks).includes('⟳ 第 2 轮服务端出错（5xx），5 秒后第 2 次尝试'), `the 5xx status (got ${json(statusTexts(chunks))})`);
            expect(usageLines(lines).length === 2, `a usage line per finished round only (got ${usageLines(lines).length})`);
        },
    },
    {
        name: '4. an attempt that showed text or an image is not redone: the original error is thrown',
        body: async () => {
            for (const [label, parts] of [
                ['text', [textPart('Partial answer')]],
                ['an image', [imagePart()]],
            ] as const) {
                reset([midStreamErrorReply([event(parts)], 429, RATE_LIMITED), answer('never sent')]);
                const { error, lines } = await runTurn();
                expect(vertex.requests.length === 1, `${label}: no second request (got ${vertex.requests.length})`);
                expect(
                    errorStatus(error) === 429 && errorMessage(error).startsWith('got status: RESOURCE_EXHAUSTED'),
                    `${label}: the SDK's own error comes out (got ${errorMessage(error)})`
                );
                expect(platform.sleeps.length === 0, `${label}: no wait`);
                expect(
                    recoverLines(lines).some((line) => line.includes('gave up after 1 attempts: showed_answer')),
                    `${label}: giving up is logged (got ${json(recoverLines(lines))})`
                );
            }
        },
    },
    {
        name: '5. broken streams: once per round, twice per reply; a mid-stream 429 then a refused 429 wait 15 s and 45 s',
        body: async () => {
            reset([
                midStreamErrorReply([event([thoughtPart('one')])], 503, 'The model is overloaded.'),
                midStreamErrorReply([event([thoughtPart('two')])], 503, 'The model is overloaded.'),
                answer('never sent'),
            ]);
            const twice = await runTurn();
            expect(vertex.requests.length === 2 && errorStatus(twice.error) === 503, 'the second break in a round ends the reply');
            expect(
                recoverLines(twice.lines).some((line) => line.includes('gave up after 2 attempts: stream_round_limit')),
                `logged (got ${json(recoverLines(twice.lines))})`
            );

            reset([
                midStreamErrorReply([event([thoughtPart('r1a')])], 500, INTERNAL),
                callRound('lookup_a', { topic: 'one' }, 'k1'),
                midStreamErrorReply([event([thoughtPart('r2a')])], 500, INTERNAL),
                callRound('lookup_b', { topic: 'two' }, 'k2'),
                midStreamErrorReply([event([thoughtPart('r3a')])], 500, INTERNAL),
                answer('never sent'),
            ]);
            const acrossRounds = await runTurn();
            expect(
                vertex.requests.length === 5 && errorStatus(acrossRounds.error) === 500,
                `the third break of the reply is final (got ${vertex.requests.length} requests)`
            );
            expect(executions.length === 2, 'the two finished rounds ran their tools');
            expect(
                recoverLines(acrossRounds.lines).some((line) => line.includes('round=3 gave up after 1 attempts: stream_reply_limit')),
                `logged (got ${json(recoverLines(acrossRounds.lines))})`
            );

            reset([
                midStreamErrorReply([event([thoughtPart('before the break')])], 429, RATE_LIMITED),
                httpErrorReply(429, RATE_LIMITED),
                answer('Third time.'),
            ]);
            const mixed = await runTurn();
            expect(mixed.error === null && vertex.requests.length === 3, 'the reply finishes on the third attempt');
            expect(json(platform.sleeps) === '[15000,45000]', `the break counts as the first 429 (got ${json(platform.sleeps)})`);
            expect(
                textOf(mixed.chunks, 'thinking') === `before the break${marker(1)}thinking before Third time.`,
                `one marker, before the thinking that came after (got ${json(textOf(mixed.chunks, 'thinking'))})`
            );
        },
    },
    {
        name: '6. never retried: a mid-stream 400, a stop, MALFORMED_FUNCTION_CALL, and a stream that ends without a reason',
        body: async () => {
            reset([midStreamErrorReply([event([thoughtPart('x')])], 400, 'Request contains an invalid argument.'), answer('never sent')]);
            const badRequest = await runTurn();
            expect(vertex.requests.length === 1 && errorStatus(badRequest.error) === 400, 'a 400 mid-stream ends the reply');
            expect(platform.sleeps.length === 0, 'without a wait');

            const controller = new AbortController();
            reset([stalledStreamReply([event([thoughtPart('thinking when stopped')])]), answer('never sent')]);
            const stopped = await runTurn({
                signal: controller.signal,
                onChunk: (chunk) => {
                    if (chunk.type === 'thinking') controller.abort();
                },
            });
            expect(vertex.requests.length === 1, `a stop sends nothing more (got ${vertex.requests.length})`);
            expect(stopped.error !== null && platform.sleeps.length === 0, `the reply ends at once (got ${errorMessage(stopped.error)})`);
            expect(vertex.requests[0]?.signal?.aborted === true, 'the stopped attempt is aborted');
            expect(
                recoverLines(stopped.lines).length === 0 && failedUsageLines(stopped.lines).length === 0,
                `a stop is no failure to log (got ${json(stopped.lines.filter((line) => line.startsWith('[gemini-')))})`
            );

            reset([sseReply([event([textPart('Trying.')], { finishReason: 'MALFORMED_FUNCTION_CALL' })]), answer('Plain answer.')]);
            const malformed = await runTurn();
            expect(
                vertex.requests.length === 2 && isModeNone(vertex.requests[1]) && platform.sleeps.length === 0,
                'MALFORMED_FUNCTION_CALL keeps its own handling: one final round, no automatic retry'
            );
            expect(recoverLines(malformed.lines).length === 0, 'and no recovery log');

            reset([sseReply([event([textPart('Cut short')])]), answer('never sent')]);
            const unfinished = await runTurn();
            expect(
                unfinished.error === null && vertex.requests.length === 1 && textOf(unfinished.chunks) === 'Cut short',
                'a stream without a finish reason and without an error is the round'
            );
            expect(
                recoverLines(unfinished.lines).some((line) => line.includes('round=1 attempt=1 ended without a finish reason')),
                `and it is logged (got ${json(recoverLines(unfinished.lines))})`
            );
        },
    },
    {
        name: '7. a dropped connection and a body timeout mid-stream are retried',
        body: async () => {
            for (const [label, code, expectedWait] of [
                ['a socket error', 'UND_ERR_SOCKET', 2000],
                ['a body timeout', 'UND_ERR_BODY_TIMEOUT', 2000],
            ] as const) {
                reset([
                    droppedStreamReply([event([thoughtPart('before the drop')])], () =>
                        new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code }) })
                    ),
                    answer('Reconnected.'),
                ]);
                const { error, chunks, lines } = await runTurn();
                expect(error === null && vertex.requests.length === 2, `${label}: retried (got ${errorMessage(error)})`);
                expect(textOf(chunks) === 'Reconnected.', `${label}: the retry answers`);
                expect(json(platform.sleeps) === json([expectedWait]), `${label}: waits ${expectedWait} ms (got ${json(platform.sleeps)})`);
                expect(
                    recoverLines(lines)[0]?.includes(`kind=${code === 'UND_ERR_SOCKET' ? 'network' : 'timeout'}`) === true,
                    `${label}: classified (got ${json(recoverLines(lines))})`
                );
            }
        },
    },
    {
        name: '7b. a connection dropped after the finish reason keeps the round: its calls run once, an answer ends the reply',
        body: async () => {
            const dropped = (): TypeError =>
                new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

            reset([
                droppedStreamReply(roundEvents([[thoughtPart('plan r1')], [callPart('lookup_a', { topic: 'falcon' }, 'r1', 'call_r1')]]), dropped),
                answer('The code word is AZALEA-42.'),
            ]);
            const usageSink = createUsageSink();
            const toolRound = await runTurn({ usageSink });
            expect(toolRound.error === null, `the reply finishes (got ${errorMessage(toolRound.error)})`);
            expect(vertex.requests.length === 2, `round 1 is not sent again (got ${vertex.requests.length} requests)`);
            expect(json(executions.map((execution) => execution.name)) === '["lookup_a"]', `its call ran once (got ${json(executions)})`);
            expect(platform.sleeps.length === 0, 'without a wait');
            expect(!textOf(toolRound.chunks, 'thinking').includes('〔'), 'and without a retry marker');
            const totals = usageSink.totals();
            expect(totals.roundRetries === 0 && totals.rounds === 2, `no automatic retry, two rounds (got ${json(totals)})`);
            expect(
                json(recoverLines(toolRound.lines)) ===
                    json(["[gemini-recover] round=1 attempt=1 broke after finishReason=STOP; kept as the round's result: terminated"]),
                `one line says the round was kept (got ${json(recoverLines(toolRound.lines))})`
            );
            expect(vertex.requests[0]?.signal?.aborted === true, 'the broken attempt is still closed');

            reset([droppedStreamReply(roundEvents([[thoughtPart('thinking first')], [textPart('The whole answer.')]]), dropped), answer('never sent')]);
            const answerRound = await runTurn();
            expect(answerRound.error === null, `the answer round ends the reply normally (got ${errorMessage(answerRound.error)})`);
            expect(vertex.requests.length === 1, `nothing more is sent (got ${vertex.requests.length})`);
            expect(textOf(answerRound.chunks) === 'The whole answer.', `the answer stands (got ${json(textOf(answerRound.chunks))})`);
            expect(answerRound.chunks.at(-1)?.type === 'done', 'and the reply ends with done');
        },
    },
    {
        name: '8. opening: 429 ×3 then success, 429 ×4 gives up, timeout ×3 gives up with the same timeout, 5xx and network once each',
        body: async () => {
            reset([httpErrorReply(429, RATE_LIMITED), httpErrorReply(429, RATE_LIMITED), httpErrorReply(429, RATE_LIMITED), answer('Fourth time.')]);
            const recovered = await runTurn();
            expect(recovered.error === null && vertex.requests.length === 4, 'the fourth attempt answers');
            expect(json(platform.sleeps) === '[15000,45000,120000]', `waits 15, 45, 120 s (got ${json(platform.sleeps)})`);
            expect(
                statusTexts(recovered.chunks).includes('⟳ 第 1 轮被限流（429），120 秒后第 4 次尝试'),
                `the status names the attempt to come (got ${json(statusTexts(recovered.chunks))})`
            );
            expect(
                new Set(vertex.requests.map((request) => request.rawBody)).size === 1,
                'all four attempts sent the same bytes'
            );

            reset([
                httpErrorReply(429, RATE_LIMITED),
                httpErrorReply(429, RATE_LIMITED),
                httpErrorReply(429, RATE_LIMITED),
                httpErrorReply(429, 'the last refusal'),
                answer('never sent'),
            ]);
            const exhausted = await runTurn();
            expect(vertex.requests.length === 4, `four attempts, no fifth (got ${vertex.requests.length})`);
            expect(
                errorStatus(exhausted.error) === 429 && errorMessage(exhausted.error).includes('the last refusal'),
                `the last error is thrown as it was (got ${errorMessage(exhausted.error)})`
            );
            expect(
                recoverLines(exhausted.lines).at(-1)?.includes('round=1 gave up after 4 attempts: kind_limit (phase=open kind=rate_limit)') === true,
                `giving up is logged (got ${json(recoverLines(exhausted.lines))})`
            );
            expect(
                statusTexts(exhausted.chunks).at(-1) === '(clear)',
                `the retry status is cleared before the error (got ${json(statusTexts(exhausted.chunks))})`
            );

            const hang: ScriptedReply = { status: 0, contentType: 'text/event-stream', body: '', hangUntilAborted: true };
            reset([hang, hang, hang, answer('never sent')]);
            const timedOut = await runTurn({ timeout: 40 });
            expect(vertex.requests.length === 3, `three attempts (got ${vertex.requests.length})`);
            expect(errorMessage(timedOut.error) === 'Timeout', `the timeout is thrown (got ${errorMessage(timedOut.error)})`);
            expect(json(platform.sleeps) === '[2000,60000]', `waits 2 s then 60 s (got ${json(platform.sleeps)})`);
            const openTimes = vertex.requests.map((request) => (request.abortedAt() ?? Number.NaN) - request.sentAt);
            expect(
                vertex.requests.every((request) => request.signal?.aborted === true) && openTimes.every((ms) => ms >= 30 && ms < 1_000),
                `every attempt was aborted after the same short timeout, no +30 s step (got ${json(openTimes)})`
            );

            reset([httpErrorReply(503, 'The service is currently unavailable.'), answer('After a 503.')]);
            const upstream = await runTurn();
            expect(upstream.error === null && json(platform.sleeps) === '[5000]', `5xx: one 5 s wait (got ${json(platform.sleeps)})`);

            reset([
                {
                    status: 0,
                    contentType: 'application/json',
                    body: '',
                    fetchError: () => new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
                },
                answer('After a reset.'),
            ]);
            const network = await runTurn();
            expect(network.error === null && json(platform.sleeps) === '[2000]', `network: one 2 s wait (got ${json(platform.sleeps)} / ${errorMessage(network.error)})`);
        },
    },
    {
        name: '9. a stop during the wait: no further attempt, the stop path',
        body: async () => {
            const controller = new AbortController();
            reset([httpErrorReply(429, RATE_LIMITED), answer('never sent')]);
            platform.onSleep = () => controller.abort();
            const usageSink = createUsageSink();

            const { error, chunks } = await runTurn({ signal: controller.signal, usageSink });

            expect(vertex.requests.length === 1, `nothing is sent after the stop (got ${vertex.requests.length})`);
            expect(errorMessage(error) === 'Aborted', `the reply ends as stopped (got ${errorMessage(error)})`);
            expect(statusTexts(chunks).length === 1, 'the waiting status was the last thing shown');
            expect(usageSink.totals().roundRetries === 0, `the retry that never went out is not counted (got ${usageSink.totals().roundRetries})`);
        },
    },
    {
        name: "9b. the platform's own waits leave no listener on the reply's stop signal, and a stop still ends one",
        body: async () => {
            const shortWaits = new ShortWaitGeminiPlatform({ client: vertex.client, random: () => 0.5 });
            const controller = new AbortController();
            reset([httpErrorReply(429, RATE_LIMITED), httpErrorReply(429, RATE_LIMITED), httpErrorReply(503, 'The service is currently unavailable.'), answer('After three waits.')]);

            const waited = await runTurn({ platform: shortWaits, signal: controller.signal });

            expect(waited.error === null && vertex.requests.length === 4, `three waits, then the answer (got ${errorMessage(waited.error)})`);
            const left = getEventListeners(controller.signal, 'abort').length;
            expect(left === 0, `no abort listener is left on the reply's signal (got ${left})`);

            const stopping = new AbortController();
            reset([httpErrorReply(429, RATE_LIMITED), answer('never sent')]);
            const stopped = await runTurn({
                platform: shortWaits,
                signal: stopping.signal,
                onChunk: (chunk) => {
                    // The waiting status goes out right before the wait starts
                    if (chunk.type === 'status' && chunk.status !== undefined) stopping.abort();
                },
            });
            expect(
                errorMessage(stopped.error) === 'Aborted' && vertex.requests.length === 1,
                `a stop during the wait ends the reply at once (got ${errorMessage(stopped.error)})`
            );
        },
    },
    {
        name: '10. the recovery budget runs out: giving up before a wait that would pass 12 minutes',
        body: async () => {
            await withFakeClock(async (jump) => {
                // Each refusal comes back after 5 minutes in the queue
                const queued429 = (): ScriptedReply => httpErrorReply(429, RATE_LIMITED, () => jump(300_000));
                reset([queued429(), queued429(), queued429(), answer('never sent')]);

                const { error, lines } = await runTurn();

                expect(vertex.requests.length === 3, `three attempts (got ${vertex.requests.length})`);
                expect(json(platform.sleeps) === '[15000,45000]', `two waits (got ${json(platform.sleeps)})`);
                expect(errorStatus(error) === 429, 'the last 429 is thrown');
                expect(
                    recoverLines(lines).at(-1)?.includes('gave up after 3 attempts: budget') === true,
                    `the budget is named (got ${json(recoverLines(lines))})`
                );
            });
        },
    },
    {
        name: '11. a final round and a no-cost round keep their shape when retried; the free round counts once',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callRound('lookup_a', { topic: 'falcon' }, 'd1'),
                    midStreamErrorReply([event([thoughtPart('final thinking')])], 500, INTERNAL),
                    answer('Final answer.'),
                ]);
                // Round 1's tool uses the whole tool budget up: round 2 is final
                afterToolExecution = () => {
                    afterToolExecution = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };

                const final = await runTurn();

                expect(final.error === null && vertex.requests.length === 3, `the final round is retried (got ${vertex.requests.length})`);
                expect(isModeNone(vertex.requests[1]) && isModeNone(vertex.requests[2]), 'both attempts with function calling off');
                expect(vertex.requests[1]?.rawBody === vertex.requests[2]?.rawBody, 'the same request');
            });

            await withFakeClock(async (jump) => {
                const freeRound = (index: number): ScriptedReply =>
                    sseReply(roundEvents([[callPart('send_file', { topic: `f${index}` }, `f${index}`, `call_f${index}`), textPart('')]]));
                reset([
                    callRound('lookup_a', { topic: 'falcon' }, 'd1'),
                    midStreamErrorReply([event([thoughtPart('free round thinking')])], 500, INTERNAL),
                    ...Array.from({ length: FREE_TOOL_ROUNDS_MAX }, (_, index) => freeRound(index + 1)),
                    answer('Files sent.'),
                ]);
                afterToolExecution = () => {
                    afterToolExecution = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };

                const free = await runTurn({ tools: turnToolsWithFree });

                const lastFreeIndex = FREE_TOOL_ROUNDS_MAX + 1;
                expect(free.error === null, `the reply finishes (got ${errorMessage(free.error)})`);
                expect(
                    vertex.requests.length === FREE_TOOL_ROUNDS_MAX + 3,
                    `round 1, the failed free attempt, ${FREE_TOOL_ROUNDS_MAX} free rounds, the answer (got ${vertex.requests.length})`
                );
                expect(vertex.requests[1]?.rawBody === vertex.requests[2]?.rawBody, 'the free round is resent unchanged');
                expect(
                    vertex.requests.slice(1, lastFreeIndex + 1).every((request) => !isModeNone(request)) &&
                        isModeNone(vertex.requests[lastFreeIndex + 1]),
                    `only the round after ${FREE_TOOL_ROUNDS_MAX} free rounds is final: the retried one counted once`
                );
                expect(
                    executions.filter((execution) => execution.name === 'send_file').length === FREE_TOOL_ROUNDS_MAX,
                    `each free round ran its call once (got ${json(executions)})`
                );
            });
        },
    },
    {
        name: "12. round 1's 400 fallback, then a 429: the fallback request is retried, and later rounds build on it",
        body: async () => {
            const messages: UnifiedMessage[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What does the clip say? Then look up falcon.' },
                        { type: 'media', mediaData: Buffer.from('fake-audio').toString('base64'), mimeType: 'audio/ogg' },
                    ],
                },
            ];
            reset([
                httpErrorReply(400, 'Request contains an invalid argument.'),
                httpErrorReply(429, RATE_LIMITED),
                callRound('lookup_a', { topic: 'falcon' }, 'm1'),
                answer('It is K-7731.'),
            ]);

            const { error, lines } = await runTurn({ messages });

            expect(error === null && vertex.requests.length === 4, `rejected, fallback refused, fallback, round 2 (got ${vertex.requests.length})`);
            expect(hasAudio(vertex.requests[0]) && !hasAudio(vertex.requests[1]), 'the fallback drops the media');
            expect(vertex.requests[1]?.rawBody === vertex.requests[2]?.rawBody, 'the 429 resends the fallback request itself');
            expect(!hasAudio(vertex.requests[3]) && declarationCount(vertex.requests[3]) === 2, 'round 2 builds on the fallback request');
            expect(json(platform.sleeps) === '[15000]', `only the 429 waited (got ${json(platform.sleeps)})`);
            expect(
                json(recoverLines(lines)) === json(['[gemini-recover] round=1 phase=open kind=rate_limit attempt=2 wait=15000ms']),
                `the 400 is the fallback's, not a recovery (got ${json(recoverLines(lines))})`
            );

            reset([
                httpErrorReply(400, `Invalid JSON payload received. Unknown name "$schema" at 'tools[2].function_declarations[0].parameters'`),
                httpErrorReply(400, 'Request contains an invalid argument.'),
            ]);
            const twice = await runTurn({ messages });
            expect(
                vertex.requests.length === 2 && errorStatus(twice.error) === 400,
                `the fallback happens once: its own 400 ends the reply (got ${vertex.requests.length})`
            );
        },
    },
    {
        name: "13. a failed attempt's grounding and complete function call are dropped, and the attempt is aborted",
        body: async () => {
            reset([
                midStreamErrorReply(
                    [event([callPart('lookup_a', { topic: 'never' }, 'x1', 'call_x1')], { grounding: groundingOf(['failed query'], ['https://failed']) })],
                    500,
                    INTERNAL
                ),
                answer('Grounded answer.', { grounding: groundingOf(['good query'], ['https://good']) }),
            ]);

            const { chunks, error } = await runTurn();

            expect(error === null && vertex.requests.length === 2, 'the retry answers');
            expect(executions.length === 0, `the failed attempt's call never ran (got ${json(executions)})`);
            const grounding = chunks.filter((chunk) => chunk.type === 'grounding');
            expect(
                grounding.length === 1 && json(grounding[0]?.groundingMetadata?.searchQueries) === '["good query"]',
                `only the finished attempt's grounding (got ${json(grounding.map((chunk) => chunk.groundingMetadata?.searchQueries))})`
            );
            expect(!(vertex.requests[1]?.rawBody ?? '').includes('call_x1'), "the dropped call is in no later request");
            expect(vertex.requests[0]?.signal?.aborted === true, 'the failed attempt is aborted (its body closes)');
            expect(vertex.requests[1]?.signal?.aborted === false, 'the attempt that answered is left alone');
        },
    },
    {
        name: '16. logs and counts: a [gemini-usage-failed] line per broken stream, [gemini-usage] lines per finished round, roundRetries',
        body: async () => {
            reset([
                httpErrorReply(503, 'The service is currently unavailable.'),
                callRound('lookup_a', { topic: 'falcon' }, 'u1'),
                // The broken attempt's last chunk reported some usage
                midStreamErrorReply([event([thoughtPart('partial')]), { ...event([]), usageMetadata: { promptTokenCount: 321 } }], 429, RATE_LIMITED),
                answer('Done.'),
            ]);
            const usageSink = createUsageSink();

            const { error, lines } = await runTurn({ usageSink });

            expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
            const failed = failedUsageLines(lines);
            expect(
                failed.length === 1 && failed[0]?.includes('round=2 kind=rate_limit attempt=1') === true && failed[0]?.includes('prompt=321') === true,
                `one failed-usage line with the broken attempt's last usage (got ${json(failed)})`
            );
            expect(usageLines(lines).length === 2, `[gemini-usage] lines = finished rounds (got ${json(usageLines(lines))})`);
            expect(
                lines.some((line) => line.includes(' summary rounds=2 ')),
                'the summary counts the finished rounds'
            );
            const totals = usageSink.totals();
            expect(totals.roundRetries === 2 && totals.rounds === 2, `two automatic retries, two rounds (got ${json(totals)})`);
            expect(totals.promptTokens === 200, 'the broken attempt is not in the totals');
        },
    },
    {
        name: '17. maxRetries 1: no automatic recovery, in opening or mid-stream',
        body: async () => {
            reset([httpErrorReply(429, RATE_LIMITED), answer('never sent')]);
            const usageSink = createUsageSink();
            const refused = await runTurn({ maxRetries: 1, usageSink });
            expect(vertex.requests.length === 1 && errorStatus(refused.error) === 429, 'a 429 ends the reply');
            expect(platform.sleeps.length === 0 && statusTexts(refused.chunks).length === 0, 'no wait, no status line');
            expect(recoverLines(refused.lines).length === 0, 'and no recovery log');
            expect(usageSink.totals().roundRetries === 0, 'nothing counted as a retry');

            reset([midStreamErrorReply([event([thoughtPart('x')])], 500, INTERNAL), answer('never sent')]);
            const broken = await runTurn({ maxRetries: 1 });
            expect(vertex.requests.length === 1 && errorStatus(broken.error) === 500, 'a broken stream ends the reply');
            expect(vertex.requests[0]?.signal?.aborted === true, 'and its attempt is still closed');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
