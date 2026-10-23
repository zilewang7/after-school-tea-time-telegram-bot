/**
 * Offline cases for the Gemini client tool loop (no containers, no network).
 *
 * Run: `npx tsx scripts/offline/tools-gemini.mts`
 *
 * GeminiPlatform gets a real Vertex-mode GoogleGenAI client whose fetch is a
 * fake: it records every request body and replays scripted SSE rounds. That
 * keeps the SDK's Vertex request/response converters in the path, which is
 * what production runs (GEMINI_API_URL would switch to the custom-endpoint
 * mode instead). The pure round helpers are tested directly first.
 */
import http from 'node:http';
import https from 'node:https';
import { FinishReason, GoogleGenAI } from '@google/genai';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult, TurnTools } from '../../src/ai/tools/index.js';

// ---------------------------------------------------------------------------
// Network guard: the offline client must never reach anything real
// ---------------------------------------------------------------------------

const outboundRequests: string[] = [];
const originalGlobalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    outboundRequests.push(`fetch ${String(input).slice(0, 120)}`);
    return originalGlobalFetch(input, init);
};
for (const [label, module] of [['http', http], ['https', https]] as const) {
    const originalRequest = module.request;
    const originalGet = module.get;
    Object.assign(module, {
        request: (...args: Parameters<typeof originalRequest>) => {
            outboundRequests.push(`${label}.request ${JSON.stringify(args[0]).slice(0, 120)}`);
            return originalRequest(...args);
        },
        get: (...args: Parameters<typeof originalGet>) => {
            outboundRequests.push(`${label}.get ${JSON.stringify(args[0]).slice(0, 120)}`);
            return originalGet(...args);
        },
    });
}

// Gemini tools on, whatever the shell says (read lazily by the platform)
delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools, NO_TURN_TOOLS, TOOL_LOOP_DEADLINE_MS } = await import('../../src/ai/tools/index.js');
const {
    buildFunctionCallingOffParts,
    buildFunctionResponseParts,
    buildRoundContents,
    FUNCTION_CALLING_OFF_ERROR,
    LAST_TOOL_ROUND_NOTICE,
    toToolCalls,
    withoutFunctionCallParts,
} = await import('../../src/ai/platforms/gemini/gemini-round-contents.js');
const { extractGroundingMetadata, mergeGroundingData } = await import('../../src/ai/platforms/gemini/gemini-grounding.js');
const { geminiPartToChunk } = await import('../../src/ai/platforms/gemini/gemini-part-chunks.js');
const { isFunctionDeclarationError, toGeminiToolList, toRoundConfig, withoutFunctionDeclarations } = await import(
    '../../src/ai/platforms/gemini/gemini-tool-request.js'
);
const { GEMINI_MAX_ROUNDS } = await import('../../src/ai/platforms/gemini/gemini-tool-loop.js');
const { GEMINI_IMAGE_MODEL } = await import('../../src/config/models.js');

// ---------------------------------------------------------------------------
// Fake Vertex endpoint
// ---------------------------------------------------------------------------

interface ScriptedReply {
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
    /** Runs when the reply is served (e.g. to move the fake clock) */
    readonly onServe?: () => void;
}

interface RecordedRequest {
    readonly url: string;
    /** The body exactly as sent, for byte-identity checks */
    readonly rawBody: string;
    readonly body: Record<string, unknown>;
}

const scriptedReplies: ScriptedReply[] = [];
const recordedRequests: RecordedRequest[] = [];

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const json = (value: unknown): string => JSON.stringify(value);

/** JSON with object keys sorted, so key order (SDK conversions) never matters */
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, nested: unknown) =>
        typeof nested === 'object' && nested !== null && !Array.isArray(nested)
            ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
            : nested
    );

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    recordedRequests.push({ url: String(input), rawBody, body: asRecord(JSON.parse(rawBody)) });
    const reply = scriptedReplies.shift();
    if (!reply) {
        return new Response(json({ error: { code: 400, message: 'unexpected request', status: 'INVALID_ARGUMENT' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }
    reply.onServe?.();
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
// Fixtures
// ---------------------------------------------------------------------------

const sse = (events: readonly unknown[], onServe?: () => void): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: events.map((event) => `data: ${json(event)}\n\n`).join(''),
    onServe,
});

const httpError = (status: number, message: string): ScriptedReply => ({
    status,
    contentType: 'application/json',
    body: json({ error: { code: status, message, status: status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' } }),
});

const signature = (label: string): string => Buffer.from(`signature-${label}`).toString('base64');

interface EventOptions {
    readonly finishReason?: string;
    readonly grounding?: Record<string, unknown>;
}

/** One streamed chunk in Vertex wire shape; finishReason / grounding mark the last one */
const event = (parts: readonly unknown[], options: EventOptions = {}) => ({
    candidates: [
        {
            content: { role: 'model', parts },
            ...(options.finishReason ? { finishReason: options.finishReason } : {}),
            ...(options.grounding ? { groundingMetadata: options.grounding } : {}),
        },
    ],
    ...(options.finishReason
        ? {
              usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 110 },
              modelVersion: 'offline-model',
          }
        : {}),
});

const thoughtPart = (text: string) => ({ text, thought: true });
const textPart = (text: string) => ({ text });
const signedEmptyText = (label: string) => ({ text: '', thoughtSignature: signature(label) });
const callPart = (name: string, args: Record<string, unknown>, label: string, id?: string) => ({
    functionCall: { ...(id ? { id } : {}), name, args },
    thoughtSignature: signature(label),
});

/** A round's chunks (one parts list each); the last one finishes the round */
const roundEvents = (rounds: readonly unknown[][], options: EventOptions = {}): unknown[] =>
    rounds.map((parts, index) =>
        index === rounds.length - 1 ? event(parts, { finishReason: 'STOP', ...options }) : event(parts)
    );

/** All parts of a scripted round, in order (what the next request must replay) */
const partsOfRound = (rounds: readonly unknown[][]): unknown[] => rounds.flat();

const groundingOf = (queries: string[], uris: string[], renderedContent?: string) => ({
    webSearchQueries: queries,
    ...(renderedContent ? { searchEntryPoint: { renderedContent } } : {}),
    groundingChunks: uris.map((uri) => ({ web: { uri, title: `title of ${uri}` } })),
});

// ---- fake tools ----

const executions: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];

const okResult = (content: string): ToolResult => ({ content, isError: false, images: [], record: null });

const objectSchema = (properties: Record<string, unknown>) => ({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
});

const lookupA: ToolHandler = {
    definition: {
        name: 'lookup_a',
        description: 'Find the key of a topic',
        inputSchema: objectSchema({ topic: { type: 'string' } }),
    },
    execute: async (args) => {
        executions.push({ name: 'lookup_a', args });
        return {
            content: `key of ${String(args.topic)} is K-7731`,
            isError: false,
            images: [],
            record: { provider: 'mcp', searchQueries: [`lookup_a ${String(args.topic)}`], citations: [] },
        };
    },
};

const lookupB: ToolHandler = {
    definition: {
        name: 'lookup_b',
        description: 'Read the code word stored under a key',
        inputSchema: objectSchema({ key: { type: 'string' } }),
    },
    execute: async (args) => {
        executions.push({ name: 'lookup_b', args });
        return okResult(`code word under ${String(args.key)} is AZALEA-42`);
    },
};

const brokenTool: ToolHandler = {
    definition: {
        name: 'broken_tool',
        description: 'Always fails',
        inputSchema: objectSchema({}),
    },
    execute: async (args) => {
        executions.push({ name: 'broken_tool', args });
        return { content: 'service unavailable', isError: true, images: [], record: null };
    },
};

const turnTools = createTurnTools([lookupA, lookupB, brokenTool]);

// ---- helpers ----

const reset = (replies: readonly ScriptedReply[]): void => {
    scriptedReplies.length = 0;
    scriptedReplies.push(...replies);
    recordedRequests.length = 0;
    executions.length = 0;
};

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

/** Run `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : json(arg))).join(' '));
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
    readonly messages?: UnifiedMessage[];
    readonly signal?: AbortSignal;
    readonly maxRetries?: number;
    readonly isImageModel?: boolean;
}

const runTurn = async (options: TurnOptions = {}): Promise<{ chunks: StreamChunk[]; lines: string[] }> => {
    const { result, lines } = await captureConsole(async () => {
        const stream = await platform.sendMessage(options.messages ?? userTurn('What is the code word for falcon?'), {
            model: options.model ?? 'gemini-3.8-flash',
            systemPrompt: 'offline system prompt',
            maxRetries: options.maxRetries ?? 1,
            ...(options.tools ? { tools: options.tools } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.isImageModel ? { isImageModel: true } : {}),
        });
        const chunks: StreamChunk[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return chunks;
    });
    return { chunks: result, lines };
};

const textOf = (chunks: readonly StreamChunk[], type: 'text' | 'thinking' = 'text'): string =>
    chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => chunk.content ?? '')
        .join('');

const contentsOf = (request: RecordedRequest | undefined): Array<Record<string, unknown>> =>
    asArray(request?.body.contents).map(asRecord);

const partsOf = (content: Record<string, unknown> | undefined): unknown[] => asArray(content?.parts);

const toolConfigOf = (request: RecordedRequest | undefined): unknown => request?.body.toolConfig;

const isModeNone = (request: RecordedRequest | undefined): boolean =>
    asRecord(asRecord(toolConfigOf(request)).functionCallingConfig).mode === 'NONE';

const declarationNamesOf = (request: RecordedRequest | undefined): string[] =>
    asArray(request?.body.tools)
        .map(asRecord)
        .flatMap((tool) => asArray(tool.functionDeclarations))
        .map((declaration) => String(asRecord(declaration).name));

const doneChunksOf = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.type === 'done');

const donePartsOf = (chunks: readonly StreamChunk[]): unknown[] =>
    asArray(asRecord(asRecord(asArray(asRecord(doneChunksOf(chunks)[0]?.rawResponse).candidates)[0]).content).parts);

const hasFunctionCall = (parts: readonly unknown[]): boolean =>
    parts.some((part) => asRecord(part).functionCall !== undefined);

const usageLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[gemini-usage]'));

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
    }
};

/** Round `index` of a turn that keeps calling lookup_a, once per round */
const lookupRound = (index: number): ScriptedReply =>
    sse(roundEvents([[thoughtPart(`round ${index}`)], [callPart('lookup_a', { topic: `t${index}` }, `l${index}`, `call_l${index}`), textPart('')]]));

/** Round 1 calls lookup_a and the reply runs past its deadline meanwhile */
const callThenDeadline = (jump: (milliseconds: number) => void): ScriptedReply =>
    sse(roundEvents([[callPart('lookup_a', { topic: 'falcon' }, 'd1', 'call_d1'), textPart('')]]), () => {
        jump(TOOL_LOOP_DEADLINE_MS + 1_000);
    });

const functionCallingOffResponse = (name: string, id?: string) => ({
    functionResponse: { ...(id ? { id } : {}), name, response: { error: FUNCTION_CALLING_OFF_ERROR } },
});

/**
 * One entry per user turn that answers function calls, in order: how many of
 * its responses carry the last-round notice, out of how many ('1/1', '0/2')
 */
const noticePatternOf = (request: RecordedRequest | undefined): string[] =>
    contentsOf(request)
        .map((content) =>
            partsOf(content)
                .map((part) => asRecord(part).functionResponse)
                .filter((functionResponse) => functionResponse !== undefined)
        )
        .filter((functionResponses) => functionResponses.length > 0)
        .map((functionResponses) => {
            const withNotice = functionResponses.filter(
                (functionResponse) => asRecord(asRecord(functionResponse).response).notice === LAST_TOOL_ROUND_NOTICE
            ).length;
            return `${withNotice}/${functionResponses.length}`;
        });

/** How often the notice text occurs anywhere in a request body */
const noticeCountOf = (request: RecordedRequest | undefined): number =>
    (request?.rawBody ?? '').split(LAST_TOOL_ROUND_NOTICE).length - 1;

const BUILT_IN_TOOLS_JSON = '[{"googleSearch":{}},{"urlContext":{}}]';

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'pure helpers: part chunks, calls, function responses, round contents, rawResponse filter',
        body: async () => {
            expect(
                json(geminiPartToChunk({ text: 'plan', thought: true })) === '{"type":"thinking","content":"plan"}',
                'a thought text part is thinking'
            );
            expect(
                geminiPartToChunk({ inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true }) === null,
                'a draft (thought) image shows nothing'
            );
            expect(json(geminiPartToChunk({ text: 'hi' })) === '{"type":"text","content":"hi"}', 'a text part is text');
            const image = geminiPartToChunk({ inlineData: { mimeType: 'image/webp', data: Buffer.from('img').toString('base64') } });
            expect(
                image?.type === 'image' && image.imageMimeType === 'image/webp' && image.imageData?.toString() === 'img',
                'an image part is an image with its mime'
            );
            expect(
                geminiPartToChunk({ functionCall: { id: 'c1', name: 'f', args: {} }, thoughtSignature: 'x' }) === null,
                'a function call part shows nothing'
            );

            const calls = toToolCalls(
                [
                    { id: 'call_123', name: 'lookup_a', args: { topic: 'falcon' } },
                    { name: 'lookup_b' },
                    { id: '', name: 'lookup_b', args: { key: 'K' } },
                ],
                2
            );
            expect(calls[0]?.id === 'call_123' && calls[0]?.argumentsJson === '{"topic":"falcon"}', 'a provider id is kept');
            expect(calls[1]?.id === 'call_2_1' && calls[1]?.argumentsJson === '{}', 'a call without id gets call_<round>_<index>, no args = {}');
            expect(calls[2]?.id === 'call_2_2', 'an empty id counts as none');

            const responseParts = buildFunctionResponseParts(
                [{ id: 'call_123', name: 'lookup_a' }, { name: 'lookup_b' }, { id: 'x', name: 'broken_tool' }],
                [okResult('found'), { content: 'boom', isError: true, images: [], record: null }]
            );
            expect(responseParts.length === 3, 'one functionResponse per call, even when a result is missing');
            expect(
                canonical(responseParts[0]) === canonical({ functionResponse: { id: 'call_123', name: 'lookup_a', response: { output: 'found' } } }),
                `a result goes back as { output }, with the provider id (got ${json(responseParts[0])})`
            );
            expect(
                canonical(responseParts[1]) === canonical({ functionResponse: { name: 'lookup_b', response: { error: 'boom' } } }),
                `an error result goes back as { error }, without an id when Gemini gave none (got ${json(responseParts[1])})`
            );
            expect(
                asRecord(asRecord(asRecord(responseParts[2]).functionResponse).response).error === 'Tool broken_tool was not run',
                'a missing result is answered as not run'
            );
            const offParts = buildFunctionCallingOffParts([{ id: 'call_9', name: 'lookup_b', args: { key: 'K' } }, { name: 'lookup_a' }]);
            expect(
                canonical(offParts) ===
                    canonical([
                        { functionResponse: { id: 'call_9', name: 'lookup_b', response: { error: FUNCTION_CALLING_OFF_ERROR } } },
                        { functionResponse: { name: 'lookup_a', response: { error: FUNCTION_CALLING_OFF_ERROR } } },
                    ]),
                `calls made with function calling off are each answered as not run (got ${json(offParts)})`
            );
            expect(
                LAST_TOOL_ROUND_NOTICE === 'No more tool calls are available for this reply; answer the user now with what you have.',
                'the last-round notice reads as specified'
            );
            const lastRoundParts = buildFunctionResponseParts(
                [{ id: 'call_7', name: 'lookup_a' }, { name: 'broken_tool' }],
                [okResult('found'), { content: 'boom', isError: true, images: [], record: null }],
                { lastToolRound: true }
            );
            expect(
                canonical(lastRoundParts) ===
                    canonical([
                        { functionResponse: { id: 'call_7', name: 'lookup_a', response: { output: 'found', notice: LAST_TOOL_ROUND_NOTICE } } },
                        { functionResponse: { name: 'broken_tool', response: { error: 'boom', notice: LAST_TOOL_ROUND_NOTICE } } },
                    ]),
                `the last tool round: the notice rides next to output and error in every response (got ${json(lastRoundParts)})`
            );
            expect(
                !json(responseParts).includes(LAST_TOOL_ROUND_NOTICE) && !json(offParts).includes(LAST_TOOL_ROUND_NOTICE),
                'other rounds and the function-calling-off answers carry no notice'
            );

            const base = [{ role: 'user', parts: [{ text: 'q' }] }];
            const firstModelParts = [{ text: 'a', thought: true }, { functionCall: { name: 'f' }, thoughtSignature: 's1' }];
            const contents = buildRoundContents(base, [
                { modelParts: firstModelParts, responseParts: [{ functionResponse: { name: 'f', response: { output: '1' } } }] },
                { modelParts: [{ functionCall: { name: 'g' }, thoughtSignature: 's2' }], responseParts: [{ functionResponse: { name: 'g', response: { output: '2' } } }] },
            ]);
            expect(
                json(contents.map((content) => content.role)) === '["user","model","user","model","user"]',
                'base contents, then a model + user turn per tool round, in order'
            );
            expect(contents[1]?.parts?.[1] === firstModelParts[1], 'model parts are replayed as the very same objects');

            const response = {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ functionCall: { name: 'f' }, thoughtSignature: 's' }, { text: '', thoughtSignature: 't' }] },
                        finishReason: FinishReason.STOP,
                    },
                ],
                usageMetadata: { totalTokenCount: 5 },
            };
            const filtered = asRecord(withoutFunctionCallParts(response));
            const filteredCandidate = asRecord(asArray(filtered.candidates)[0]);
            expect(
                json(asRecord(filteredCandidate.content).parts) === '[{"text":"","thoughtSignature":"t"}]',
                'functionCall parts leave the stored rawResponse'
            );
            expect(
                filteredCandidate.finishReason === 'STOP' && json(filtered.usageMetadata) === '{"totalTokenCount":5}',
                'everything else stays'
            );
            const untouched = { candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }] };
            expect(withoutFunctionCallParts(untouched) === untouched, 'a response without calls comes back as is');
        },
    },
    {
        name: 'pure helpers: grounding merge, declaration errors, round config',
        body: async () => {
            const merged = mergeGroundingData([
                { searchQueries: ['q1'], searchEntryPoint: { renderedContent: '<a href="s1">q1</a>' }, groundingChunks: [] },
                {
                    searchQueries: ['q1', 'q2'],
                    searchEntryPoint: { renderedContent: '<a href="s1">q1</a>' },
                    groundingChunks: [{ web: { uri: 'https://a', title: 'A' } }],
                },
                {
                    searchQueries: ['q2'],
                    searchEntryPoint: { renderedContent: '<a href="s2">q2</a>' },
                    groundingChunks: [{ web: { uri: 'https://a', title: 'A again' } }, { web: { uri: 'https://b', title: 'B' } }],
                },
            ]);
            expect(json(merged?.searchQueries) === '["q1","q2"]', `queries are de-duplicated (got ${json(merged?.searchQueries)})`);
            expect(
                json(merged?.groundingChunks?.map((groundingChunk) => groundingChunk.web?.uri)) === '["https://a","https://b"]',
                'sources are de-duplicated by uri, first one kept'
            );
            expect(
                merged?.searchEntryPoint?.renderedContent === '<a href="s1">q1</a><a href="s2">q2</a>',
                'the distinct rendered search pages are joined'
            );
            expect(mergeGroundingData([]) === null, 'no grounding, nothing to merge');

            const fromChunk = extractGroundingMetadata({
                candidates: [{ groundingMetadata: { webSearchQueries: ['  ', 'q'], groundingChunks: [] } }],
            });
            expect(json(fromChunk?.searchQueries) === '["q"]', 'blank queries are dropped when reading a chunk');

            const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });
            expect(
                isFunctionDeclarationError(
                    apiError(400, `Invalid JSON payload received. Unknown name "$schema" at 'tools[2].function_declarations[0].parameters': Cannot find field.`)
                ),
                'a function_declarations field path is a declaration error'
            );
            expect(isFunctionDeclarationError(apiError(400, 'bad tools[2].parameters_json_schema')), 'parameters_json_schema too');
            expect(
                isFunctionDeclarationError(apiError(400, 'Multiple tools are supported only when they are all search tools.')),
                'and a model that only combines search tools'
            );
            expect(!isFunctionDeclarationError(apiError(400, 'Request contains an invalid argument.')), 'another 400 is not');
            expect(
                !isFunctionDeclarationError(apiError(400, 'Function call is missing a thought_signature in functionCall parts.')),
                'nor a missing signature'
            );
            expect(!isFunctionDeclarationError(apiError(500, 'function_declarations backend error')), 'nor a 500');
            expect(!isFunctionDeclarationError('function_declarations'), 'nor something without a status');

            const definitions = turnTools.definitions;
            const toolList = toGeminiToolList(definitions);
            expect(
                json(toolList.slice(0, 2)) === BUILT_IN_TOOLS_JSON && toolList.length === 3,
                'search tools first, then ONE Tool with every declaration'
            );
            expect(
                json(toolList[2]?.functionDeclarations?.map((declaration) => declaration.name)) === '["lookup_a","lookup_b","broken_tool"]',
                'declarations keep the turn order'
            );
            expect(json(withoutFunctionDeclarations(toolList)) === BUILT_IN_TOOLS_JSON, 'dropping declarations leaves the search tools');

            const baseConfig = { systemInstruction: 'sys', tools: [{ googleSearch: {} }] };
            const open = toRoundConfig(baseConfig, { contents: [], tools: toolList, final: false });
            expect(open.toolConfig === undefined && open.tools?.length === 3 && open.systemInstruction === 'sys', 'a normal round: tools replaced, no toolConfig');
            const final = toRoundConfig(baseConfig, { contents: [], tools: toolList, final: true });
            expect(json(final.toolConfig) === '{"functionCallingConfig":{"mode":"NONE"}}', 'the final round switches function calling off');
            const finalWithout = toRoundConfig(baseConfig, { contents: [], tools: withoutFunctionDeclarations(toolList), final: true });
            expect(finalWithout.toolConfig === undefined, 'no toolConfig when nothing is declared');
            expect(GEMINI_MAX_ROUNDS === 10, 'at most 10 rounds, the deadline being the real bound');
        },
    },
    {
        name: 'two tool rounds then the answer: every round replayed with its signatures',
        body: async () => {
            const round1 = [
                [thoughtPart('plan the lookup')],
                [textPart('Let me look that up.')],
                [callPart('lookup_a', { topic: 'falcon' }, 'r1', 'call_a'), textPart('')],
            ];
            const round2 = [[thoughtPart('now the code word')], [callPart('lookup_b', { key: 'K-7731' }, 'r2')]];
            const round3 = [[textPart('The code word is AZALEA-42.')], [signedEmptyText('r3')]];
            reset([
                sse(roundEvents(round1, { grounding: groundingOf(['falcon key'], [], '<a href="s1">falcon key</a>') })),
                sse(roundEvents(round2, { grounding: groundingOf(['falcon key'], ['https://a'], '<a href="s1">falcon key</a>') })),
                sse(roundEvents(round3, { grounding: groundingOf(['falcon key', 'azalea'], ['https://a', 'https://b'], '<a href="s2">azalea</a>') })),
            ]);

            const { chunks, lines } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === 3, `three requests (got ${recordedRequests.length})`);
            expect(
                recordedRequests.every((request) => request.url.includes('/projects/test/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent')),
                'every round streams from the Vertex path'
            );
            for (const [index, request] of recordedRequests.entries()) {
                const tools = asArray(request.body.tools);
                expect(
                    json(tools.slice(0, 2)) === BUILT_IN_TOOLS_JSON && tools.length === 3,
                    `request ${index + 1}: googleSearch, urlContext and one functionDeclarations Tool`
                );
                expect(
                    json(declarationNamesOf(request)) === '["lookup_a","lookup_b","broken_tool"]',
                    `request ${index + 1}: all declarations in that one Tool`
                );
                expect(toolConfigOf(request) === undefined, `request ${index + 1}: no toolConfig (function calling on)`);
                expect(!json(request.body).includes('includeServerSideToolInvocations'), `request ${index + 1}: no includeServerSideToolInvocations`);
            }
            const firstDeclaration = asRecord(asArray(asRecord(asArray(recordedRequests[0]?.body.tools)[2]).functionDeclarations)[0]);
            expect(
                asRecord(firstDeclaration.parametersJsonSchema).$schema === 'http://json-schema.org/draft-07/schema#',
                'the schema goes out verbatim as parametersJsonSchema'
            );

            const third = contentsOf(recordedRequests[2]);
            expect(
                json(third.map((content) => content.role)) === '["user","model","user","model","user"]',
                `round 3 sends base + both tool rounds (got ${json(third.map((content) => content.role))})`
            );
            expect(canonical(partsOf(third[1])) === canonical(partsOfRound(round1)), 'round 1 model turn replayed verbatim, signature included');
            expect(canonical(partsOf(third[3])) === canonical(partsOfRound(round2)), 'round 2 model turn replayed verbatim, signature included');
            expect(
                canonical(partsOf(third[2])) ===
                    canonical([{ functionResponse: { id: 'call_a', name: 'lookup_a', response: { output: 'key of falcon is K-7731' } } }]),
                `round 1 answered with its id (got ${json(partsOf(third[2]))})`
            );
            expect(
                canonical(partsOf(third[4])) ===
                    canonical([{ functionResponse: { name: 'lookup_b', response: { output: 'code word under K-7731 is AZALEA-42' } } }]),
                `round 2 answered without an id, as Gemini gave none (got ${json(partsOf(third[4]))})`
            );
            const second = contentsOf(recordedRequests[1]);
            expect(canonical(second) === canonical(third.slice(0, 3)), 'round 2 sent base + round 1 only');
            expect(
                recordedRequests.every((request) => noticeCountOf(request) === 0),
                'the reply ended before any final round: no notice anywhere'
            );

            expect(
                json(executions) === '[{"name":"lookup_a","args":{"topic":"falcon"}},{"name":"lookup_b","args":{"key":"K-7731"}}]',
                `the calls ran once each, in order (got ${json(executions)})`
            );
            expect(
                textOf(chunks) === 'Let me look that up.\n\nThe code word is AZALEA-42.',
                `text streams with a blank line between rounds (got ${json(textOf(chunks))})`
            );
            expect(textOf(chunks, 'thinking') === 'plan the lookupnow the code word', 'thinking streams live');
            expect(
                chunks.every((chunk) => !(chunk.type === 'text' && chunk.content === '')),
                'empty text parts are not yielded'
            );

            const statuses = chunks.filter((chunk) => chunk.type === 'status');
            expect(
                statuses.length === 4 &&
                    statuses[0]?.status?.text.includes('lookup_a') === true &&
                    statuses[1]?.status === undefined &&
                    statuses[2]?.status?.text.includes('lookup_b') === true &&
                    statuses[3]?.status === undefined,
                'a status per call, cleared after each round'
            );

            const groundingChunks = chunks.filter((chunk) => chunk.type === 'grounding');
            const googleGrounding = groundingChunks.filter((chunk) => chunk.groundingMetadata?.provider !== 'mcp');
            expect(googleGrounding.length === 1, `Google grounding is yielded once (got ${googleGrounding.length})`);
            expect(groundingChunks.length === 2 && groundingChunks[0]?.groundingMetadata?.provider === 'mcp', 'the tool record streams live, before it');
            const merged = googleGrounding[0]?.groundingMetadata;
            expect(json(merged?.searchQueries) === '["falcon key","azalea"]', `merged queries (got ${json(merged?.searchQueries)})`);
            expect(merged?.groundingChunks?.length === 2, 'merged sources');
            expect(
                merged?.searchEntryPoint?.renderedContent === '<a href="s1">falcon key</a><a href="s2">azalea</a>',
                'merged search pages'
            );
            expect(chunks.at(-2)?.type === 'grounding' && chunks.at(-1)?.type === 'done', 'grounding right before done, done last');

            const done = doneChunksOf(chunks);
            expect(done.length === 1, 'exactly one done');
            expect(
                json(done[0]?.agentStats?.toolUsage) === '[{"name":"lookup_a","count":1},{"name":"lookup_b","count":1}]',
                `tool usage from the tally (got ${json(done[0]?.agentStats?.toolUsage)})`
            );
            expect(canonical(donePartsOf(chunks)) === canonical([signedEmptyText('r3')]), 'rawResponse is the last chunk of the last round');

            const usage = usageLines(lines);
            expect(usage.length === 4, `a usage line per round plus a summary (got ${usage.length})`);
            expect(
                usage[0]?.includes('round=1 calls=1') === true &&
                    usage[1]?.includes('round=2 calls=1') === true &&
                    usage[2]?.includes('round=3 calls=0') === true,
                'rounds and calls are labelled'
            );
            expect(
                usage[3]?.includes('summary rounds=3 calls=2 prompt=300 cached=120') === true,
                `the summary adds the rounds up (got ${usage[3]})`
            );
        },
    },
    {
        name: 'parallel calls: one user turn with a response per call, in call order',
        body: async () => {
            const round1 = [
                [thoughtPart('two things at once')],
                [callPart('lookup_a', { topic: 'owl' }, 'p1', 'call_p1'), callPart('broken_tool', {}, 'p2', 'call_p2'), textPart('')],
            ];
            reset([sse(roundEvents(round1)), sse(roundEvents([[textPart('Done.')]]))]);

            const { chunks } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === 2, 'two requests');
            expect(json(executions.map((execution) => execution.name)) === '["lookup_a","broken_tool"]', 'both calls ran, in order');
            const second = contentsOf(recordedRequests[1]);
            expect(second.length === 3 && second[2]?.role === 'user', 'one user turn answers the round');
            expect(
                canonical(partsOf(second[2])) ===
                    canonical([
                        { functionResponse: { id: 'call_p1', name: 'lookup_a', response: { output: 'key of owl is K-7731' } } },
                        { functionResponse: { id: 'call_p2', name: 'broken_tool', response: { error: 'service unavailable' } } },
                    ]),
                `two responses with their ids, error as { error } (got ${json(partsOf(second[2]))})`
            );
            expect(canonical(partsOf(second[1])) === canonical(partsOfRound(round1)), 'the model turn carries both calls verbatim');
            expect(noticeCountOf(recordedRequests[1]) === 0, 'round 2 may still call: no notice');
            expect(
                json(doneChunksOf(chunks)[0]?.agentStats?.toolUsage) === '[{"name":"lookup_a","count":1},{"name":"broken_tool","count":1}]',
                'both counted'
            );
        },
    },
    {
        name: 'round-1 400 on the declarations: retried once without them, no fallback later',
        body: async () => {
            reset([
                httpError(400, `Invalid JSON payload received. Unknown name "$schema" at 'tools[2].function_declarations[0].parameters': Cannot find field.`),
                sse(roundEvents([[textPart('Answer without tools.')], [signedEmptyText('fb')]])),
            ]);

            const { chunks, lines } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === 2, `the rejected request plus one retry (got ${recordedRequests.length})`);
            expect(declarationNamesOf(recordedRequests[0]).length === 3, 'the first attempt declared the tools');
            expect(json(recordedRequests[1]?.body.tools) === BUILT_IN_TOOLS_JSON, 'the retry carries the search tools only');
            expect(toolConfigOf(recordedRequests[1]) === undefined, 'and no toolConfig');
            expect(
                canonical(recordedRequests[1]?.body.contents) === canonical(recordedRequests[0]?.body.contents),
                'with the same contents'
            );
            expect(
                lines.some((line) => line.startsWith('[gemini]') && line.includes('rejected the function declarations')),
                'the fallback is logged as an error'
            );
            expect(textOf(chunks) === 'Answer without tools.' && doneChunksOf(chunks).length === 1, 'the reply still answers');
            expect(executions.length === 0, 'nothing ran');
        },
    },
    {
        name: 'round-1 400 with non-image media: stripped once, the stripped contents pinned for later rounds',
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
                httpError(400, 'Request contains an invalid argument.'),
                sse(roundEvents([[callPart('lookup_a', { topic: 'falcon' }, 'm1', 'call_m1'), textPart('')]])),
                sse(roundEvents([[textPart('It is K-7731.')]])),
            ]);

            const { chunks } = await runTurn({ tools: turnTools, messages });

            expect(recordedRequests.length === 3, `rejected + stripped retry + round 2 (got ${recordedRequests.length})`);
            const hasAudio = (request: RecordedRequest | undefined): boolean => json(request?.body.contents).includes('audio/ogg');
            expect(hasAudio(recordedRequests[0]) && !hasAudio(recordedRequests[1]), 'the retry drops the media');
            expect(declarationNamesOf(recordedRequests[1]).length === 3, 'but keeps the declarations');
            expect(!hasAudio(recordedRequests[2]), 'round 2 builds on the stripped contents');
            expect(declarationNamesOf(recordedRequests[2]).length === 3, 'with the same tools');
            expect(
                canonical(contentsOf(recordedRequests[2])[0]) === canonical(contentsOf(recordedRequests[1])[0]),
                'round 2 replays exactly what round 1 finally sent'
            );
            expect(textOf(chunks) === 'It is K-7731.' && executions.length === 1, 'the loop went on as usual');

            reset([httpError(400, 'Request contains an invalid argument.')]);
            let thrown: unknown = null;
            await runTurn({ tools: turnTools }).catch((error: unknown) => {
                thrown = error;
            });
            expect(
                thrown instanceof Error && thrown.message.includes('invalid argument') && recordedRequests.length === 1,
                'any other 400 fails sendMessage without a retry'
            );
        },
    },
    {
        name: `the round limit: only round ${GEMINI_MAX_ROUNDS - 1} carries the notice, round ${GEMINI_MAX_ROUNDS} goes out with mode NONE and answers`,
        body: async () => {
            const toolRounds = GEMINI_MAX_ROUNDS - 1;
            reset([
                ...Array.from({ length: toolRounds }, (_, index) => lookupRound(index + 1)),
                sse(roundEvents([[textPart('The code word is AZALEA-42.')], [signedEmptyText('l-end')]])),
            ]);

            const { chunks, lines } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === GEMINI_MAX_ROUNDS, `the limit (got ${recordedRequests.length})`);
            expect(
                recordedRequests.slice(0, toolRounds).every((request) => toolConfigOf(request) === undefined),
                `rounds 1-${toolRounds} may call functions`
            );
            expect(isModeNone(recordedRequests[toolRounds]), `round ${GEMINI_MAX_ROUNDS} sets mode NONE`);
            expect(declarationNamesOf(recordedRequests[toolRounds]).length === 3, 'with the same declarations');
            expect(contentsOf(recordedRequests[toolRounds]).length === toolRounds * 2 + 1, `all ${toolRounds} tool rounds replayed`);
            const expectedNotices = Array.from({ length: GEMINI_MAX_ROUNDS }, (_, index) =>
                index === toolRounds
                    ? [...Array<string>(toolRounds - 1).fill('0/1'), '1/1']
                    : Array<string>(index).fill('0/1')
            );
            expect(
                json(recordedRequests.map(noticePatternOf)) === json(expectedNotices),
                `only the round before the final one carries the notice (got ${json(recordedRequests.map(noticePatternOf))})`
            );
            expect(
                json(recordedRequests.map(noticeCountOf)) === json([...Array<number>(toolRounds).fill(0), 1]),
                'and the notice appears nowhere else'
            );
            const lastToolRoundResponses = partsOf(contentsOf(recordedRequests[toolRounds])[toolRounds * 2]);
            expect(
                canonical(lastToolRoundResponses) ===
                    canonical([
                        {
                            functionResponse: {
                                id: `call_l${toolRounds}`,
                                name: 'lookup_a',
                                response: { output: `key of t${toolRounds} is K-7731`, notice: LAST_TOOL_ROUND_NOTICE },
                            },
                        },
                    ]),
                `next to the round ${toolRounds} output (got ${json(lastToolRoundResponses)})`
            );
            expect(executions.length === toolRounds, `${toolRounds} tool rounds ran`);
            expect(
                lines.some(
                    (line) => line.includes('Tool round limit reached') && line.includes(`notice on the round ${toolRounds} responses`)
                ),
                'the limit and the notice are logged'
            );
            expect(textOf(chunks) === 'The code word is AZALEA-42.' && doneChunksOf(chunks).length === 1, 'the final round answers, one done');
            expect(canonical(donePartsOf(chunks)) === canonical([signedEmptyText('l-end')]), "rawResponse is the final round's last chunk");
            expect(
                json(doneChunksOf(chunks)[0]?.agentStats?.toolUsage) === json([{ name: 'lookup_a', count: toolRounds }]),
                `${toolRounds} calls counted`
            );
        },
    },
    {
        name: 'a final round with text and calls: the calls never run, one more request, both texts shown apart',
        body: async () => {
            const toolRounds = GEMINI_MAX_ROUNDS - 1;
            const finalIndex = toolRounds;
            const retryIndex = toolRounds + 1;
            const finalRound = [
                [textPart('Let me check one more thing.')],
                [callPart('lookup_b', { key: 'K-7731' }, 'l5', 'call_l5'), signedEmptyText('l5-end')],
            ];
            reset([
                ...Array.from({ length: toolRounds }, (_, index) => lookupRound(index + 1)),
                sse(roundEvents(finalRound)),
                sse(roundEvents([[textPart('The code word is AZALEA-42.')], [signedEmptyText('l6-end')]])),
            ]);

            const { chunks, lines } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === GEMINI_MAX_ROUNDS + 1, `the limit plus one retry (got ${recordedRequests.length})`);
            expect(
                isModeNone(recordedRequests[finalIndex]) && isModeNone(recordedRequests[retryIndex]),
                'both of the last two with function calling off'
            );
            const retryContents = contentsOf(recordedRequests[retryIndex]);
            const finalContents = contentsOf(recordedRequests[finalIndex]);
            expect(
                canonical(retryContents.slice(0, finalContents.length)) === canonical(finalContents),
                'the retry builds on what the final round sent, the notice replayed as is'
            );
            expect(
                canonical(partsOf(retryContents[finalContents.length])) === canonical(partsOfRound(finalRound)),
                'the final round replayed verbatim: text, call, signatures'
            );
            expect(
                canonical(partsOf(retryContents[finalContents.length + 1])) ===
                    canonical([functionCallingOffResponse('lookup_b', 'call_l5')]),
                `its call answered as not run (got ${json(partsOf(retryContents[finalContents.length + 1]))})`
            );
            expect(
                json(noticePatternOf(recordedRequests[retryIndex])) ===
                    json([...Array<string>(toolRounds - 1).fill('0/1'), '1/1', '0/1']) &&
                    noticeCountOf(recordedRequests[retryIndex]) === 1,
                `the not-run answers carry no notice (got ${json(noticePatternOf(recordedRequests[retryIndex]))})`
            );
            expect(
                executions.length === toolRounds && executions.every((execution) => execution.name === 'lookup_a'),
                'the final round call never ran'
            );
            expect(
                textOf(chunks) === 'Let me check one more thing.\n\nThe code word is AZALEA-42.',
                `the text of both rounds shows, a blank line apart (got ${json(textOf(chunks))})`
            );
            expect(
                lines.some((line) => line.includes(`final round ${retryIndex} still made 1 function call(s) after some text`)),
                'the retry is logged'
            );
            const done = doneChunksOf(chunks);
            expect(
                done.length === 1 && json(done[0]?.agentStats?.toolUsage) === json([{ name: 'lookup_a', count: toolRounds }]),
                'one done, and the call that never ran is not counted'
            );
            expect(canonical(donePartsOf(chunks)) === canonical([signedEmptyText('l6-end')]), 'rawResponse is the last chunk of the retry');
        },
    },
    {
        name: 'the deadline: the round just run carries the notice, the next round goes out with mode NONE',
        body: async () => {
            await withFakeClock(async (jump) => {
                const round2 = [[callPart('lookup_b', { key: 'K-7731' }, 'd2a', 'call_d2a'), callPart('broken_tool', {}, 'd2b'), textPart('')]];
                reset([
                    sse(roundEvents([[callPart('lookup_a', { topic: 'falcon' }, 'd1', 'call_d1'), textPart('')]])),
                    // The deadline passes while round 2 streams
                    sse(roundEvents(round2), () => {
                        jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                    }),
                    sse(roundEvents([[textPart('Out of time, here is what I have.')]])),
                ]);

                const { chunks, lines } = await runTurn({ tools: turnTools });

                expect(recordedRequests.length === 3, `three requests (got ${recordedRequests.length})`);
                expect(
                    toolConfigOf(recordedRequests[0]) === undefined && toolConfigOf(recordedRequests[1]) === undefined && isModeNone(recordedRequests[2]),
                    'round 3 is final'
                );
                expect(
                    json(recordedRequests.map(noticePatternOf)) === json([[], ['0/1'], ['0/1', '2/2']]) &&
                        json(recordedRequests.map(noticeCountOf)) === '[0,0,2]',
                    `only round 2, run past the deadline, carries the notice, on each response (got ${json(recordedRequests.map(noticePatternOf))})`
                );
                expect(
                    canonical(partsOf(contentsOf(recordedRequests[2])[4])) ===
                        canonical([
                            {
                                functionResponse: {
                                    id: 'call_d2a',
                                    name: 'lookup_b',
                                    response: { output: 'code word under K-7731 is AZALEA-42', notice: LAST_TOOL_ROUND_NOTICE },
                                },
                            },
                            { functionResponse: { name: 'broken_tool', response: { error: 'service unavailable', notice: LAST_TOOL_ROUND_NOTICE } } },
                        ]),
                    `next to output and error (got ${json(partsOf(contentsOf(recordedRequests[2])[4]))})`
                );
                expect(
                    lines.some((line) => line.includes('deadline (180s) passed') && line.includes('notice on the round 2 responses')),
                    'the deadline and the notice are logged'
                );
                expect(executions.length === 3, 'the calls of rounds 1 and 2 still ran');
                expect(textOf(chunks) === 'Out of time, here is what I have.', 'the final round answers');
            });
        },
    },
    {
        name: 'a final round that only calls: its calls are answered as not run, then one more request',
        body: async () => {
            await withFakeClock(async (jump) => {
                const finalRound = [
                    [thoughtPart('still need the code word')],
                    [callPart('lookup_b', { key: 'K-7731' }, 'f2', 'call_f2'), textPart('')],
                ];
                reset([
                    callThenDeadline(jump),
                    sse(roundEvents(finalRound)),
                    sse(roundEvents([[textPart('I could not read the code word in time.')], [signedEmptyText('f3')]])),
                ]);

                const { chunks, lines } = await runTurn({ tools: turnTools });

                expect(recordedRequests.length === 3, `round 1, the final round, one more (got ${recordedRequests.length})`);
                expect(
                    toolConfigOf(recordedRequests[0]) === undefined && isModeNone(recordedRequests[1]) && isModeNone(recordedRequests[2]),
                    'function calling stays off for the extra request'
                );
                expect(declarationNamesOf(recordedRequests[2]).length === 3, 'which keeps the same declarations');
                const third = contentsOf(recordedRequests[2]);
                expect(
                    json(third.map((content) => content.role)) === '["user","model","user","model","user"]',
                    `it adds the final round as a tool round (got ${json(third.map((content) => content.role))})`
                );
                expect(canonical(third.slice(0, 3)) === canonical(contentsOf(recordedRequests[1])), 'on top of what the final round sent');
                expect(
                    json(noticePatternOf(recordedRequests[1])) === '["1/1"]' && json(noticePatternOf(recordedRequests[2])) === '["1/1","0/1"]',
                    `round 1, run past the deadline, carries the notice, replayed as is; the not-run answer has none (got ${json(noticePatternOf(recordedRequests[2]))})`
                );
                expect(canonical(partsOf(third[3])) === canonical(partsOfRound(finalRound)), 'the final round replayed verbatim, signature included');
                expect(
                    canonical(partsOf(third[4])) === canonical([functionCallingOffResponse('lookup_b', 'call_f2')]),
                    `its call answered as not run, with the id (got ${json(partsOf(third[4]))})`
                );
                expect(json(executions) === '[{"name":"lookup_a","args":{"topic":"falcon"}}]', `only round 1 ran a tool (got ${json(executions)})`);

                expect(textOf(chunks) === 'I could not read the code word in time.', `the extra request answers (got ${json(textOf(chunks))})`);
                expect(textOf(chunks, 'thinking') === 'still need the code word', "the final round's thinking still shows");
                const statuses = chunks.filter((chunk) => chunk.type === 'status');
                expect(
                    statuses.length === 2 && statuses[0]?.status?.text.includes('lookup_a') === true && statuses[1]?.status === undefined,
                    'no status line for the call that never ran'
                );
                const done = doneChunksOf(chunks);
                expect(
                    done.length === 1 && json(done[0]?.agentStats?.toolUsage) === '[{"name":"lookup_a","count":1}]',
                    'one done, and the call that never ran is not counted'
                );
                expect(canonical(donePartsOf(chunks)) === canonical([signedEmptyText('f3')]), 'rawResponse is the last chunk of the extra request');
                expect(lines.some((line) => line.includes('final round 2 still made 1 function call(s) and no text')), 'the extra request is logged');
                const usage = usageLines(lines);
                expect(
                    usage.length === 4 &&
                        usage[1]?.includes('round=2 calls=1') === true &&
                        usage[2]?.includes('round=3 calls=0') === true &&
                        usage[3]?.includes('summary rounds=3 calls=1') === true,
                    `a usage line per request; the summary counts the calls that ran (got ${json(usage)})`
                );
            });
        },
    },
    {
        name: 'the extra request is the last one: parallel calls all answered, what it asks for never runs',
        body: async () => {
            await withFakeClock(async (jump) => {
                const finalRound = [
                    [callPart('lookup_b', { key: 'K-7731' }, 'p2a', 'call_p2a'), callPart('broken_tool', {}, 'p2b'), textPart('  ')],
                ];
                reset([
                    callThenDeadline(jump),
                    sse(roundEvents(finalRound)),
                    sse(roundEvents([[callPart('lookup_b', { key: 'K-7731' }, 'p3', 'call_p3'), signedEmptyText('p3-end')]])),
                ]);

                const { chunks, lines } = await runTurn({ tools: turnTools });

                expect(recordedRequests.length === 3, `no fourth request (got ${recordedRequests.length})`);
                expect(
                    canonical(partsOf(contentsOf(recordedRequests[2])[4])) ===
                        canonical([functionCallingOffResponse('lookup_b', 'call_p2a'), functionCallingOffResponse('broken_tool')]),
                    `one user turn answers both calls, ids only where Gemini gave one (got ${json(partsOf(contentsOf(recordedRequests[2])[4]))})`
                );
                expect(json(noticePatternOf(recordedRequests[2])) === '["1/1","0/2"]', 'the notice stays on round 1 only');
                expect(executions.length === 1, 'only round 1 ran a tool');
                expect(lines.some((line) => line.includes('round 3 still asked for 1 function call(s)')), 'the extra request calling again is logged');
                expect(textOf(chunks).trim() === '' && doneChunksOf(chunks).length === 1, 'the reply ends there, with one done');
                expect(!hasFunctionCall(donePartsOf(chunks)), 'no functionCall stored');
            });
        },
    },
    {
        name: 'the round limit plus the extra request: one more request at most',
        body: async () => {
            const toolRounds = GEMINI_MAX_ROUNDS - 1;
            const toolRound = (index: number) =>
                sse(roundEvents([[callPart('lookup_a', { topic: `t${index}` }, `x${index}`, `call_x${index}`), textPart('')]]));
            reset([
                ...Array.from({ length: toolRounds }, (_, index) => toolRound(index + 1)),
                sse(roundEvents([[callPart('lookup_b', { key: 'K' }, 'x5', 'call_x5'), textPart('')]])),
                sse(roundEvents([[textPart('Here is what the lookups found.')]])),
            ]);

            const { chunks } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === GEMINI_MAX_ROUNDS + 1, `the limit plus one (got ${recordedRequests.length})`);
            expect(
                isModeNone(recordedRequests[toolRounds]) && isModeNone(recordedRequests[toolRounds + 1]),
                'both of the last two with function calling off'
            );
            expect(contentsOf(recordedRequests[toolRounds + 1]).length === toolRounds * 2 + 3, 'the retry replays every round');
            expect(
                json(noticePatternOf(recordedRequests[toolRounds + 1])) ===
                    json([...Array<string>(toolRounds - 1).fill('0/1'), '1/1', '0/1']),
                `the notice on round ${toolRounds} only (got ${json(noticePatternOf(recordedRequests[toolRounds + 1]))})`
            );
            expect(executions.length === toolRounds, 'the final round calls never ran');
            expect(textOf(chunks) === 'Here is what the lookups found.', 'and the retry answers');
        },
    },
    {
        name: 'MALFORMED_FUNCTION_CALL, then a final round that only calls: one more request',
        body: async () => {
            const finalRound = [[callPart('lookup_a', { topic: 'falcon' }, 'mf2', 'call_mf2'), textPart('')]];
            reset([
                sse([event([textPart('Trying.')], { finishReason: 'MALFORMED_FUNCTION_CALL' })]),
                sse(roundEvents(finalRound)),
                sse(roundEvents([[textPart('Plain answer.')]])),
            ]);

            const { chunks } = await runTurn({ tools: turnTools });

            expect(recordedRequests.length === 3, `the failed round, the final round, one more (got ${recordedRequests.length})`);
            const third = contentsOf(recordedRequests[2]);
            expect(
                json(third.map((content) => content.role)) === '["user","model","user"]' &&
                    canonical(third[0]) === canonical(contentsOf(recordedRequests[0])[0]),
                'the extra request adds only the final round (the failed round is not replayed)'
            );
            expect(canonical(partsOf(third[2])) === canonical([functionCallingOffResponse('lookup_a', 'call_mf2')]), 'its call answered as not run');
            expect(recordedRequests.every((request) => noticeCountOf(request) === 0), 'no tool round ran, so no notice anywhere');
            expect(executions.length === 0, 'nothing ran');
            expect(textOf(chunks) === 'Trying.\n\nPlain answer.', `the text of both answering rounds shows (got ${json(textOf(chunks))})`);
        },
    },
    {
        name: 'MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL go straight to the final round',
        body: async () => {
            for (const finishReason of ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']) {
                reset([
                    sse([event([textPart('Trying.')], { finishReason })]),
                    sse(roundEvents([[textPart('Plain answer.')]])),
                ]);
                const { chunks } = await runTurn({ tools: turnTools });
                expect(recordedRequests.length === 2 && isModeNone(recordedRequests[1]), `${finishReason}: the retry is the final round`);
                expect(
                    canonical(recordedRequests[1]?.body.contents) === canonical(recordedRequests[0]?.body.contents),
                    `${finishReason}: with the same contents (the failed round is not replayed)`
                );
                expect(executions.length === 0, `${finishReason}: nothing ran`);
                expect(textOf(chunks) === 'Trying.\n\nPlain answer.', `${finishReason}: both rounds show (got ${json(textOf(chunks))})`);
            }
        },
    },
    {
        name: 'a stop between rounds: no further request, one done without functionCall',
        body: async () => {
            const controller = new AbortController();
            const stopper: ToolHandler = {
                definition: { name: 'stop_now', description: 'Stops the reply', inputSchema: objectSchema({}) },
                execute: async (args) => {
                    executions.push({ name: 'stop_now', args });
                    controller.abort();
                    return okResult('stopped');
                },
            };
            reset([sse(roundEvents([[textPart('One moment.')], [callPart('stop_now', {}, 's1', 'call_s1'), textPart('')]]))]);

            const { chunks } = await runTurn({ tools: createTurnTools([stopper]), signal: controller.signal });

            expect(recordedRequests.length === 1, 'nothing is sent after the stop');
            expect(executions.length === 1, 'the tool ran once');
            const done = doneChunksOf(chunks);
            expect(done.length === 1 && chunks.at(-1)?.type === 'done', 'one done, last');
            const doneParts = donePartsOf(chunks);
            expect(!hasFunctionCall(doneParts) && doneParts.length === 1, `the stored parts drop the functionCall (got ${json(doneParts)})`);
            expect(json(done[0]?.agentStats?.toolUsage) === '[{"name":"stop_now","count":1}]', 'the call is counted');
        },
    },
    {
        name: 'a transport retry on a later round reopens that round only; tools never run twice',
        body: async () => {
            reset([
                sse(roundEvents([[callPart('lookup_a', { topic: 'retry' }, 't1', 'call_t1'), textPart('')]])),
                httpError(503, 'The service is currently unavailable.'),
                sse(roundEvents([[textPart('Recovered.')]])),
            ]);

            const { chunks } = await runTurn({ tools: turnTools, maxRetries: 2 });

            expect(recordedRequests.length === 3, `round 1, the failed round 2, its retry (got ${recordedRequests.length})`);
            expect(executions.length === 1, 'the tool ran once');
            expect(canonical(recordedRequests[2]?.body) === canonical(recordedRequests[1]?.body), 'the retry resends round 2 unchanged');
            expect(textOf(chunks) === 'Recovered.', 'and the reply finishes');
        },
    },
    {
        name: 'gs:// media: no function declarations, byte for byte the request without tools',
        body: async () => {
            const messages: UnifiedMessage[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Summarise the video.' },
                        { type: 'media', fileUri: 'gs://offline-bucket/clip.mp4', mimeType: 'video/mp4', durationSeconds: 30 },
                    ],
                },
            ];
            const videoRound = () =>
                sse([
                    event([thoughtPart('watching')]),
                    event([textPart('A short clip.')]),
                    event([signedEmptyText('g1-end')], { finishReason: 'STOP', grounding: groundingOf(['clip'], ['https://a']) }),
                ]);
            const normalizedUsageLines = (lines: readonly string[]): string[] =>
                usageLines(lines).map((line) => line.replace(/=\d+ms/g, '=Nms'));

            reset([videoRound()]);
            const withTools = await runTurn({ tools: turnTools, messages });
            const toolsRequest = recordedRequests[0];
            expect(recordedRequests.length === 1, 'one request');
            expect(
                declarationNamesOf(toolsRequest).length === 0 && json(toolsRequest?.body.tools) === BUILT_IN_TOOLS_JSON,
                `no function declarations, the search tools only (got ${json(toolsRequest?.body.tools)})`
            );
            expect(toolConfigOf(toolsRequest) === undefined, 'and no toolConfig');
            expect(json(toolsRequest?.body.contents).includes('gs://offline-bucket/clip.mp4'), 'the gs:// file is in it');
            expect(
                withTools.lines.some((line) => line.includes('gs:// media → single request without client tools')),
                'leaving the tools out is logged'
            );
            expect(!withTools.lines.some((line) => line.includes('client tool(s)')), 'and the tool loop never starts');
            expect(executions.length === 0, 'nothing ran');

            reset([videoRound()]);
            const withoutTools = await runTurn({ messages });
            expect(toolsRequest?.rawBody === recordedRequests[0]?.rawBody, 'the body is byte for byte the one sent without tools');
            expect(toolsRequest?.url === recordedRequests[0]?.url, 'to the same endpoint');
            expect(
                json(withTools.chunks.map((chunk) => chunk.type)) === '["thinking","text","text","grounding","done"]' &&
                    json(withTools.chunks) === json(withoutTools.chunks),
                `the same single-request chunks (got ${json(withTools.chunks.map((chunk) => chunk.type))})`
            );
            expect(
                json(normalizedUsageLines(withTools.lines)) === json(normalizedUsageLines(withoutTools.lines)) &&
                    !(usageLines(withTools.lines)[0] ?? '').includes('round='),
                'and the same single usage line'
            );
        },
    },
    {
        name: 'without the loop the request is what it always was',
        body: async () => {
            const plainRound = () =>
                sse([
                    event([thoughtPart('thinking')]),
                    event([textPart('hello')]),
                    event([signedEmptyText('plain')], { finishReason: 'STOP', grounding: groundingOf(['q'], ['https://a']) }),
                ]);

            reset([plainRound()]);
            const plain = await runTurn();
            const plainBody = recordedRequests[0]?.body;
            expect(recordedRequests.length === 1, 'one request');
            expect(json(plainBody?.tools) === BUILT_IN_TOOLS_JSON, `googleSearch + urlContext only (got ${json(plainBody?.tools)})`);
            expect(plainBody?.toolConfig === undefined, 'no toolConfig');
            expect(
                json(asRecord(plainBody?.generationConfig).thinkingConfig) === '{"includeThoughts":true,"thinkingBudget":-1}',
                'thinking config unchanged'
            );
            expect(json(plainBody?.systemInstruction).includes('offline system prompt'), 'the system prompt goes out');
            expect(
                json(plain.chunks.map((chunk) => chunk.type)) === '["thinking","text","text","grounding","done"]',
                `the single-request stream shape is unchanged (got ${json(plain.chunks.map((chunk) => chunk.type))})`
            );
            expect(canonical(donePartsOf(plain.chunks)) === canonical([signedEmptyText('plain')]), 'rawResponse is the last chunk');
            expect(
                usageLines(plain.lines).length === 1 && !(usageLines(plain.lines)[0] ?? '').includes('round='),
                'one usage line, without round labels'
            );

            reset([plainRound()]);
            await runTurn({ tools: NO_TURN_TOOLS });
            expect(canonical(recordedRequests[0]?.body) === canonical(plainBody), 'no tool definitions: the same request');

            reset([plainRound()]);
            await runTurn({ model: 'gemini-2.5-flash' });
            const unsupportedPlain = recordedRequests[0]?.body;
            reset([plainRound()]);
            await runTurn({ model: 'gemini-2.5-flash', tools: turnTools });
            expect(
                canonical(recordedRequests[0]?.body) === canonical(unsupportedPlain) && executions.length === 0,
                'a model outside the verified list ignores the tools'
            );

            reset([
                sse([
                    event([{ inlineData: { mimeType: 'image/png', data: Buffer.from('draft').toString('base64') }, thought: true }]),
                    event([{ inlineData: { mimeType: 'image/png', data: Buffer.from('final').toString('base64') } }], { finishReason: 'STOP' }),
                ]),
            ]);
            const image = await runTurn({ model: GEMINI_IMAGE_MODEL, tools: turnTools, isImageModel: true });
            expect(
                json(recordedRequests[0]?.body.tools) ===
                    '[{"googleSearch":{"searchTypes":{"imageSearch":{},"webSearch":{}}}}]',
                `an image model gets image-search grounding, no declarations (got ${json(recordedRequests[0]?.body.tools)})`
            );

            // A model that rejects imageSearch keeps the plain search tool
            reset([
                sse([
                    event([{ inlineData: { mimeType: 'image/png', data: Buffer.from('final').toString('base64') } }], {
                        finishReason: 'STOP',
                    }),
                ]),
            ]);
            await runTurn({ model: 'gemini-3-pro-image', tools: turnTools, isImageModel: true });
            expect(
                json(recordedRequests[0]?.body.tools) === '[{"googleSearch":{}}]',
                'gemini-3-pro-image (no imageSearch support) keeps the plain googleSearch'
            );
            const images = image.chunks.filter((chunk) => chunk.type === 'image');
            expect(images.length === 1 && images[0]?.imageData?.toString() === 'final', 'and still yields only the final image');
        },
    },
    {
        name: 'the offline client never touched the network',
        body: async () => {
            expect(outboundRequests.length === 0, `no outbound request (got ${json(outboundRequests)})`);
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
