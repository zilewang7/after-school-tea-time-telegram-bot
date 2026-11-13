/**
 * Offline cases for the Gemini 4 Hydrogen XHIGH thinking level (no network).
 *
 * Run: `npx tsx scripts/offline/gemini-thinking-level.mts`
 *
 * GeminiPlatform gets a real Vertex-mode GoogleGenAI client whose fetch is a
 * fake: every request body is recorded and answered from a script, so the SDK's
 * own request/response converters stay in the path (that is what production
 * runs). The cases cover the level per model and the 400 fallback, in both the
 * single-request path and the client tool loop.
 */
import { GoogleGenAI } from '@google/genai';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, TurnTools } from '../../src/ai/tools/index.js';

// Client tools on, whatever the shell says (read lazily by the platform)
delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { supportsXhighThinkingLevel } = await import('../../src/ai/model-kinds.js');
const { isThinkingLevelError } = await import('../../src/ai/platforms/gemini/gemini-tool-request.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');

// ---------------------------------------------------------------------------
// Fake Vertex endpoint
// ---------------------------------------------------------------------------

interface ScriptedReply {
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
}

interface RecordedRequest {
    readonly body: Record<string, unknown>;
}

const scriptedReplies: ScriptedReply[] = [];
const recordedRequests: RecordedRequest[] = [];

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const json = (value: unknown): string => JSON.stringify(value);

const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    recordedRequests.push({ body: asRecord(JSON.parse(rawBody)) });
    const reply = scriptedReplies.shift();
    if (!reply) {
        return new Response(
            json({ error: { code: 400, message: 'unexpected request', status: 'INVALID_ARGUMENT' } }),
            { status: 400, headers: { 'content-type': 'application/json' } }
        );
    }
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.contentType } });
};

const geminiClient = new GoogleGenAI({
    vertexai: true,
    project: 'test',
    location: 'global',
    // An api key and project id keep google-auth-library off ADC and the metadata server
    googleAuthOptions: { apiKey: 'offline', projectId: 'test' },
    httpOptions: { fetch: fakeFetch },
});
const platform = new GeminiPlatform({ client: geminiClient });

// ---------------------------------------------------------------------------
// Scripted replies
// ---------------------------------------------------------------------------

const sse = (events: readonly unknown[]): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: events.map((event) => `data: ${json(event)}\n\n`).join(''),
});

const httpError = (status: number, message: string): ScriptedReply => ({
    status,
    contentType: 'application/json',
    body: json({
        error: { code: status, message, status: status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' },
    }),
});

/** The 400 a model that does not take XHIGH answers with */
const xhighRejected = (): ScriptedReply =>
    httpError(400, 'Thinking level is unsupported: THINKING_LEVEL_XHIGH');

/** The 400 a model answers with when it does not take the requested level */
const levelRejected = (level: string): ScriptedReply =>
    httpError(400, `Thinking level is unsupported: THINKING_LEVEL_${level.toUpperCase()}`);

/** One streamed chunk in Vertex wire shape; finishReason marks the last one */
const event = (parts: readonly unknown[], finishReason?: string) => ({
    candidates: [
        {
            content: { role: 'model', parts },
            ...(finishReason ? { finishReason } : {}),
        },
    ],
    ...(finishReason
        ? {
              usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 7,
                  thoughtsTokenCount: 3,
                  totalTokenCount: 110,
              },
          }
        : {}),
});

const signature = (label: string): string => Buffer.from(`signature-${label}`).toString('base64');

/** A round's chunks; the last one finishes the round */
const roundEvents = (chunks: readonly unknown[][]): unknown[] =>
    chunks.map((parts, index) =>
        index === chunks.length - 1 ? event(parts, 'STOP') : event(parts)
    );

const callPart = (name: string, args: Record<string, unknown>): unknown => ({
    functionCall: { name, args },
    thoughtSignature: signature(name),
});

const reset = (replies: readonly ScriptedReply[]): void => {
    scriptedReplies.length = 0;
    scriptedReplies.push(...replies);
    recordedRequests.length = 0;
};

// ---------------------------------------------------------------------------
// Platform driving
// ---------------------------------------------------------------------------

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

/** Runs `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (typeof arg === 'string' ? arg : json(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return { result: await body(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

interface TurnOptions {
    readonly model?: string;
    readonly tools?: TurnTools;
    /** Absent: the platform keeps its legacy hard-coded level */
    readonly thinkingEffort?: { readonly mode: 'default' | 'explicit' | 'off'; readonly value: string | null };
    /** Absent: a single attempt per request, so no automatic recovery in the tool loop */
    readonly maxRetries?: number;
}

const runTurn = async (options: TurnOptions = {}): Promise<{ chunks: StreamChunk[]; lines: string[] }> => {
    const { result, lines } = await captureConsole(async () => {
        const stream = await platform.sendMessage(userTurn('offline prompt'), {
            model: options.model ?? 'gemini-4-hydrogen',
            systemPrompt: 'offline system prompt',
            maxRetries: options.maxRetries ?? 1,
            ...(options.tools ? { tools: options.tools } : {}),
            ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
        });
        const chunks: StreamChunk[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return chunks;
    });
    return { chunks: result, lines };
};

const textOf = (chunks: readonly StreamChunk[]): string =>
    chunks
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.content ?? '')
        .join('');

const thinkingConfigOf = (request: RecordedRequest | undefined): Record<string, unknown> =>
    asRecord(asRecord(request?.body.generationConfig).thinkingConfig);

const thinkingLevelsOf = (): unknown[] =>
    recordedRequests.map((request) => thinkingConfigOf(request).thinkingLevel);

// ---- fake tool for the tool-loop cases ----

const lookupTool: ToolHandler = {
    definition: {
        name: 'lookup',
        description: 'Find a stored value',
        inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { key: { type: 'string' } },
        },
    },
    execute: async (args) => ({
        content: `value under ${String(args.key)}`,
        isError: false,
        images: [],
        record: null,
    }),
};

const turnTools = createTurnTools([lookupTool]);

/** A round that calls the fake tool, then the round that answers */
const toolCallRound = (): unknown[] => roundEvents([[callPart('lookup', { key: 'K' })]]);
const answerRound = (text: string): unknown[] => roundEvents([[{ text }]]);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'only hydrogen takes XHIGH',
        body: async () => {
            expect(supportsXhighThinkingLevel('gemini-4-hydrogen'), 'hydrogen takes XHIGH');
            expect(supportsXhighThinkingLevel('gemini-4-hydrogen-001'), 'a hydrogen version suffix takes XHIGH');
            expect(supportsXhighThinkingLevel('GEMINI-4-HYDROGEN'), 'the id is case-insensitive');
            expect(!supportsXhighThinkingLevel('gemini-4-argon'), 'argon keeps HIGH');
            expect(!supportsXhighThinkingLevel('gemini-4-carbon'), 'carbon keeps HIGH');
            expect(!supportsXhighThinkingLevel('gemini-3.8-flash'), 'a non-Gemini-4 model keeps its budget');
        },
    },
    {
        name: 'a 400 that blames the thinking level is recognised',
        body: async () => {
            const unsupported = Object.assign(new Error('Thinking level is unsupported: THINKING_LEVEL_XHIGH'), {
                status: 400,
            });
            expect(isThinkingLevelError(unsupported), 'the model-side refusal matches');
            expect(!isThinkingLevelError(Object.assign(new Error('invalid argument'), { status: 400 })), 'another 400 does not');
            expect(!isThinkingLevelError(Object.assign(new Error('Thinking level is unsupported'), { status: 500 })), 'a 500 does not');
            expect(!isThinkingLevelError(new Error('Thinking level is unsupported')), 'an error without a status does not');
        },
    },
    {
        name: 'hydrogen sends XHIGH while argon and carbon keep HIGH',
        body: async () => {
            reset([sse(answerRound('hydrogen answer'))]);
            const hydrogen = await runTurn({ model: 'gemini-4-hydrogen' });
            expect(thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'XHIGH', `hydrogen sends XHIGH (got ${json(thinkingLevelsOf())})`);
            expect(thinkingConfigOf(recordedRequests[0]).includeThoughts === true, 'thought summaries stay on');
            expect(textOf(hydrogen.chunks) === 'hydrogen answer', 'the answer streams');
            expect(hydrogen.lines.some((line) => line.includes('thinking level XHIGH')), 'the XHIGH level is logged');

            reset([sse(answerRound('argon answer'))]);
            await runTurn({ model: 'gemini-4-argon' });
            expect(thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'HIGH', `argon sends HIGH (got ${json(thinkingLevelsOf())})`);

            reset([sse(answerRound('carbon answer'))]);
            await runTurn({ model: 'gemini-4-carbon' });
            expect(thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'HIGH', `carbon sends HIGH (got ${json(thinkingLevelsOf())})`);
        },
    },
    {
        name: 'a model before Gemini 4 keeps the automatic thinking budget',
        body: async () => {
            reset([sse(answerRound('flash answer'))]);
            await runTurn({ model: 'gemini-3.8-flash' });
            const config = thinkingConfigOf(recordedRequests[0]);
            expect(config.thinkingBudget === -1, `the budget stays automatic (got ${json(config)})`);
            expect(config.thinkingLevel === undefined, 'no thinking level is sent');
        },
    },
    {
        name: 'an XHIGH 400 falls back to HIGH for the single request',
        body: async () => {
            reset([xhighRejected(), sse(answerRound('fallback answer'))]);
            const { chunks, lines } = await runTurn({ model: 'gemini-4-hydrogen' });

            expect(recordedRequests.length === 2, `one retry (got ${recordedRequests.length})`);
            expect(json(thinkingLevelsOf()) === json(['XHIGH', 'HIGH']), `XHIGH then HIGH (got ${json(thinkingLevelsOf())})`);
            expect(textOf(chunks) === 'fallback answer', 'the retry answers');
            expect(lines.some((line) => line.includes('rejected the XHIGH thinking level')), 'the fallback is warned about');
        },
    },
    {
        name: 'the tool loop opens round 1 with XHIGH',
        body: async () => {
            reset([sse(answerRound('tool answer'))]);
            const { chunks } = await runTurn({ model: 'gemini-4-hydrogen', tools: turnTools });
            expect(recordedRequests.length === 1, `one round (got ${recordedRequests.length})`);
            expect(thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'XHIGH', `round 1 sends XHIGH (got ${json(thinkingLevelsOf())})`);
            expect(textOf(chunks) === 'tool answer', 'the answer streams');
        },
    },
    {
        name: 'an XHIGH 400 on round 1 falls back to HIGH for every later round',
        body: async () => {
            reset([xhighRejected(), sse(toolCallRound()), sse(answerRound('tool fallback answer'))]);
            const { chunks } = await runTurn({ model: 'gemini-4-hydrogen', tools: turnTools });

            expect(recordedRequests.length === 3, `rejected round 1, tool round, answer round (got ${recordedRequests.length})`);
            expect(
                json(thinkingLevelsOf()) === json(['XHIGH', 'HIGH', 'HIGH']),
                `only the rejected attempt used XHIGH (got ${json(thinkingLevelsOf())})`
            );
            expect(textOf(chunks) === 'tool fallback answer', 'the reply answers after the fallback');
        },
    },
    {
        name: 'default sends no level on Gemini 4 and keeps the automatic budget before Gemini 4',
        body: async () => {
            for (const model of ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon']) {
                reset([sse(answerRound('default answer'))]);
                await runTurn({ model, thinkingEffort: { mode: 'default', value: null } });
                const config = thinkingConfigOf(recordedRequests[0]);
                expect(
                    config.includeThoughts === true && config.thinkingLevel === undefined && config.thinkingBudget === undefined,
                    `${model}: default sends includeThoughts alone (got ${json(config)})`
                );
            }

            reset([sse(answerRound('flash answer'))]);
            await runTurn({ model: 'gemini-3.8-flash', thinkingEffort: { mode: 'default', value: null } });
            const flash = thinkingConfigOf(recordedRequests[0]);
            expect(
                flash.thinkingBudget === -1 && flash.thinkingLevel === undefined,
                `a pre-Gemini-4 model keeps its automatic budget (got ${json(flash)})`
            );

            reset([sse(answerRound('image answer'))]);
            await runTurn({ model: 'gemini-nano-banana-2.1', thinkingEffort: { mode: 'default', value: null } });
            expect(
                thinkingConfigOf(recordedRequests[0]).thinkingBudget === -1,
                `the image model keeps its automatic budget (got ${json(thinkingConfigOf(recordedRequests[0]))})`
            );
        },
    },
    {
        name: 'an explicit effort goes out as the uppercase wire level',
        body: async () => {
            reset([sse(answerRound('hydrogen answer'))]);
            const hydrogen = await runTurn({
                model: 'gemini-4-hydrogen',
                thinkingEffort: { mode: 'explicit', value: 'xhigh' },
            });
            expect(
                thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'XHIGH',
                `hydrogen sends XHIGH (got ${json(thinkingLevelsOf())})`
            );
            expect(
                hydrogen.lines.some((line) => line.includes('thinking level XHIGH')),
                `the explicit level is logged (got ${json(hydrogen.lines)})`
            );

            reset([sse(answerRound('argon answer'))]);
            await runTurn({ model: 'gemini-4-argon', thinkingEffort: { mode: 'explicit', value: 'low' } });
            expect(
                thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'LOW',
                `a lower-case value is sent uppercase (got ${json(thinkingLevelsOf())})`
            );

            reset([sse(answerRound('flash answer'))]);
            await runTurn({ model: 'gemini-3.8-flash', thinkingEffort: { mode: 'explicit', value: 'high' } });
            expect(
                thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'HIGH' &&
                    thinkingConfigOf(recordedRequests[0]).thinkingBudget === undefined,
                `a pre-Gemini-4 model sends the level instead of the budget (got ${json(thinkingConfigOf(recordedRequests[0]))})`
            );
        },
    },
    {
        name: 'off cannot disable Gemini thinking and behaves like the default',
        body: async () => {
            reset([sse(answerRound('argon answer'))]);
            await runTurn({ model: 'gemini-4-argon', thinkingEffort: { mode: 'off', value: null } });
            const config = thinkingConfigOf(recordedRequests[0]);
            expect(
                config.includeThoughts === true && config.thinkingLevel === undefined && config.thinkingBudget === undefined,
                `Gemini 4 ignores off and sends no level (got ${json(config)})`
            );

            reset([sse(answerRound('flash answer'))]);
            await runTurn({ model: 'gemini-3.8-flash', thinkingEffort: { mode: 'off', value: null } });
            expect(
                thinkingConfigOf(recordedRequests[0]).thinkingBudget === -1,
                `a pre-Gemini-4 model keeps the automatic budget (got ${json(thinkingConfigOf(recordedRequests[0]))})`
            );
        },
    },
    {
        name: 'an explicit level the model rejects falls back to HIGH once',
        body: async () => {
            reset([levelRejected('low'), sse(answerRound('fallback answer'))]);
            const { chunks, lines } = await runTurn({
                model: 'gemini-4-argon',
                thinkingEffort: { mode: 'explicit', value: 'low' },
            });
            expect(recordedRequests.length === 2, `one fallback retry (got ${recordedRequests.length})`);
            expect(json(thinkingLevelsOf()) === json(['LOW', 'HIGH']), `LOW then HIGH (got ${json(thinkingLevelsOf())})`);
            expect(textOf(chunks) === 'fallback answer', 'the retry answers');
            expect(
                lines.some((line) => line.includes('rejected the LOW thinking level; retrying with HIGH')),
                `the downgrade is logged (got ${json(lines)})`
            );
        },
    },
    {
        name: 'a pre-Gemini-4 explicit level falls back to the automatic budget',
        body: async () => {
            reset([levelRejected('high'), sse(answerRound('budget answer'))]);
            const { chunks } = await runTurn({
                model: 'gemini-3.8-flash',
                thinkingEffort: { mode: 'explicit', value: 'high' },
            });
            expect(recordedRequests.length === 2, `one fallback retry (got ${recordedRequests.length})`);
            expect(thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'HIGH', 'the first attempt sends the level');
            const fallback = thinkingConfigOf(recordedRequests[1]);
            expect(
                fallback.thinkingBudget === -1 && fallback.thinkingLevel === undefined,
                `the retry uses the automatic budget (got ${json(fallback)})`
            );
            expect(textOf(chunks) === 'budget answer', 'the retry answers');
        },
    },
    {
        name: 'the tool loop shares an explicit downgrade across rounds',
        body: async () => {
            reset([levelRejected('xhigh'), sse(toolCallRound()), sse(answerRound('tool fallback answer'))]);
            const { chunks } = await runTurn({
                model: 'gemini-4-hydrogen',
                tools: turnTools,
                thinkingEffort: { mode: 'explicit', value: 'xhigh' },
            });
            expect(recordedRequests.length === 3, `rejected round 1, tool round, answer round (got ${recordedRequests.length})`);
            expect(
                json(thinkingLevelsOf()) === json(['XHIGH', 'HIGH', 'HIGH']),
                `only the rejected attempt used the explicit level (got ${json(thinkingLevelsOf())})`
            );
            expect(textOf(chunks) === 'tool fallback answer', 'the reply answers after the fallback');
        },
    },
    {
        name: '401 and 429 with a thinking-level message are not an effort downgrade',
        body: async () => {
            for (const status of [401, 429]) {
                reset([httpError(status, 'Thinking level is unsupported: THINKING_LEVEL_LOW')]);
                let error: unknown = null;
                try {
                    await runTurn({
                        model: 'gemini-4-argon',
                        thinkingEffort: { mode: 'explicit', value: 'low' },
                    });
                } catch (caught) {
                    error = caught;
                }
                expect(error !== null, `${status}: the reply fails`);
                expect(recordedRequests.length === 1, `${status}: no downgrade retry (got ${recordedRequests.length})`);
                expect(
                    thinkingConfigOf(recordedRequests[0]).thinkingLevel === 'LOW',
                    `${status}: the body is unchanged (got ${json(thinkingLevelsOf())})`
                );
            }
        },
    },
    {
        name: 'with automatic recovery on, the XHIGH fallback is no failed attempt of the round',
        body: async () => {
            reset([xhighRejected(), sse(toolCallRound()), sse(answerRound('recovered without waiting'))]);
            const { chunks, lines } = await runTurn({ model: 'gemini-4-hydrogen', tools: turnTools, maxRetries: 3 });

            expect(
                json(thinkingLevelsOf()) === json(['XHIGH', 'HIGH', 'HIGH']),
                `the same round goes out again at HIGH (got ${json(thinkingLevelsOf())})`
            );
            expect(textOf(chunks) === 'recovered without waiting', 'the reply answers');
            // A 400 is no retryable failure: had the runner seen it, the reply would have ended
            expect(!lines.some((line) => line.includes('[gemini-recover]')), 'the recovery policy never saw the 400');
            expect(!chunks.some((chunk) => chunk.type === 'status' && (chunk.content ?? '').includes('重试')), 'no retry status line');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
