/**
 * Offline cases for the Grok (xAI) client tool loop (no containers, no
 * network).
 *
 * Run: npx tsx scripts/offline/tools-grok.mts
 *
 * The platform talks to a local `/v1/responses` stub that answers each request
 * with a scripted SSE round (or a 400) and records the request body, so the
 * cases check both what the loop streams and what it sends to xAI: the
 * fallback candidates, the continuation chain and the final round.
 */
import { createServer } from 'node:http';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, TurnTools } from '../../src/ai/tools/index.js';

interface RecordedRequest {
    readonly path: string;
    readonly body: Record<string, unknown>;
}

interface StubReply {
    /** 200 = `body` is an SSE stream; anything else = a JSON error with `body` as its message */
    readonly status: number;
    readonly body: string;
}

/** A stream event as the fixtures write it: typed loosely, the stub only serializes it */
type EventFixture = Readonly<Record<string, unknown>> & { readonly type: string };

type Responder = (request: RecordedRequest) => StubReply;

const recordedRequests: RecordedRequest[] = [];
let respond: Responder = () => ({ status: 400, body: 'no responder set' });

const stubServer = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on('data', (part: Buffer) => bodyParts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        const rawBody = Buffer.concat(bodyParts).toString('utf8');
        const recorded: RecordedRequest = { path, body: rawBody ? JSON.parse(rawBody) : {} };
        recordedRequests.push(recorded);

        const reply: StubReply =
            path === '/v1/responses' ? respond(recorded) : { status: 400, body: `unexpected request to ${path}` };
        if (reply.status === 200) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(reply.body);
            return;
        }
        response.writeHead(reply.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: reply.body } }));
    });
});
await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', () => resolve()));
const stubAddress = stubServer.address();
if (stubAddress === null || typeof stubAddress === 'string') {
    throw new Error('the stub server has no TCP address');
}

// The platform reads these in its constructor
process.env.GROK_API_URL = `http://127.0.0.1:${stubAddress.port}/v1`;
process.env.GROK_API_KEY = 'offline-stub';

const { GrokPlatform } = await import('../../src/ai/platforms/grok-platform.js');
const { runGrokToolLoop } = await import('../../src/ai/platforms/grok/grok-tool-loop.js');
const { buildCandidateRequests, buildSearchTools, toGrokFunctionTools } = await import(
    '../../src/ai/platforms/grok/grok-request.js'
);
const { createTurnTools, NO_TURN_TOOLS } = await import('../../src/ai/tools/index.js');

const MODEL = 'grok-4.7';
const MULTI_AGENT_MODEL = 'grok-4.20-multi-agent-0309';

// ---- fake tools ----

const executions: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];

/** Shaped like an MCP tool schema, `$schema` included: the wire format must strip it */
const WEATHER_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    additionalProperties: false,
};

const weatherTool: ToolHandler = {
    definition: {
        name: 'lookup_weather',
        description: 'Look up the weather of a city',
        inputSchema: WEATHER_SCHEMA,
    },
    execute: async (args) => {
        executions.push({ name: 'lookup_weather', args });
        return { content: `sunny in ${String(args.city)}`, isError: false, images: [], record: null };
    },
};

const brokenTool: ToolHandler = {
    definition: {
        name: 'broken_tool',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
    },
    execute: async (args) => {
        executions.push({ name: 'broken_tool', args });
        return { content: 'service unavailable', isError: true, images: [], record: null };
    },
};

const turnTools = createTurnTools([weatherTool, brokenTool]);

// ---- helpers ----

const reset = (responder: Responder): void => {
    respond = responder;
    recordedRequests.length = 0;
    executions.length = 0;
};

/** Replies in order; a request past the script is a 400 that never triggers a fallback */
const scripted = (...replies: StubReply[]): Responder => {
    const queue = [...replies];
    return () => queue.shift() ?? { status: 400, body: 'unexpected extra request' };
};

const drain = async (stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
};

/** Run `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record =
        (level: string) =>
        (...args: unknown[]): void => {
            const rendered = args.map((arg) =>
                arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)
            );
            lines.push(`${level} ${rendered.join(' ')}`);
        };
    console.log = record('log');
    console.warn = record('warn');
    console.error = record('error');
    try {
        return { result: await body(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

const textOf = (chunks: readonly StreamChunk[], type: 'text' | 'thinking' = 'text'): string =>
    chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => chunk.content ?? '')
        .join('');

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The per-call tool-rounds line is injected by the loops; comparisons ignore it */
const withoutRoundsLeft = (text: string): string => text.replace(/\n\n\[工具轮次\][^\n]*/g, '');
const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? withoutRoundsLeft(item) : item));

const toolsOf = (request: RecordedRequest | undefined): Record<string, unknown>[] =>
    asArray(request?.body.tools).map(asRecord);

const functionToolsOf = (request: RecordedRequest | undefined): Record<string, unknown>[] =>
    toolsOf(request).filter((tool) => tool.type === 'function');

const hasFunctionTools = (request: RecordedRequest): boolean => functionToolsOf(request).length > 0;

/** `tools` is explicit: undefined means a turn without client tools */
const sendGrok = async (
    model: string,
    tools: TurnTools | undefined,
    signal?: AbortSignal
): Promise<AsyncIterable<StreamChunk>> =>
    new GrokPlatform().sendMessage(userTurn('What is the weather in Paris?'), {
        model,
        systemPrompt: 'offline persona',
        timeout: 20000,
        tools,
        signal,
    });

// ---- xAI-shaped fixtures (see tmp/grok-fc-probe.log) ----

const sse = (events: readonly EventFixture[]): string =>
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const ok = (events: readonly EventFixture[]): StubReply => ({ status: 200, body: sse(events) });

const badRequest = (message: string): StubReply => ({ status: 400, body: message });

interface ResponseFixtureOptions {
    readonly status?: string;
    readonly usage?: Record<string, unknown>;
    readonly extra?: Record<string, unknown>;
}

const responseObject = (id: string, output: readonly unknown[], options: ResponseFixtureOptions = {}) => ({
    id,
    object: 'response',
    created_at: 0,
    status: options.status ?? 'completed',
    model: MODEL,
    output,
    error: null,
    incomplete_details: null,
    store: true,
    usage: options.usage ?? {
        input_tokens: 100,
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 110,
    },
    ...options.extra,
});

const functionCallItem = (callId: string, name: string, argumentsJson: string) => ({
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: 'completed',
});

const messageItem = (text: string, annotations: readonly unknown[] = []) => ({
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
});

const webSearchItem = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'paris' } };
/** xAI's X search shows up as a custom tool call */
const xSearchItem = {
    type: 'custom_tool_call',
    id: 'ctc_1',
    call_id: 'call-x-1',
    name: 'x_keyword_search',
    input: '{"query":"paris"}',
    status: 'completed',
};

/** A function call streamed like xAI does: added (no arguments), arguments, done */
const streamedFunctionCall = (outputIndex: number, callId: string, name: string, argumentsJson: string): EventFixture[] => [
    {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { ...functionCallItem(callId, name, ''), status: 'in_progress' },
    },
    { type: 'response.function_call_arguments.delta', item_id: `fc_${callId}`, output_index: outputIndex, delta: argumentsJson },
    { type: 'response.function_call_arguments.done', item_id: `fc_${callId}`, output_index: outputIndex, arguments: argumentsJson },
    { type: 'response.output_item.done', output_index: outputIndex, item: functionCallItem(callId, name, argumentsJson) },
];

const textDelta = (delta: string): EventFixture => ({
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta,
});

const completed = (response: unknown): EventFixture => ({ type: 'response.completed', response });

/** A round that only calls one client tool */
const toolRound = (responseId: string, callId: string, name = 'lookup_weather', argumentsJson = '{"city":"Paris"}'): StubReply => {
    const call = functionCallItem(callId, name, argumentsJson);
    return ok([...streamedFunctionCall(0, callId, name, argumentsJson), completed(responseObject(responseId, [call]))]);
};

/** A round that answers */
const answerRound = (responseId: string, text: string, output: readonly unknown[] = [messageItem(text)]): StubReply =>
    ok([textDelta(text), completed(responseObject(responseId, output))]);

/** The request today's non-tool path sends, minus input and model */
const TODAY_TOOLS = [
    { type: 'web_search', enable_image_understanding: true },
    { type: 'x_search', enable_image_understanding: true, enable_video_understanding: true },
    { type: 'code_interpreter' },
];

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'grok runs a function call and continues on the response chain',
        body: async () => {
            const call = functionCallItem('call_paris', 'lookup_weather', '{"city":"Paris"}');
            const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed' };
            const firstRound: EventFixture[] = [
                { type: 'response.created', response: responseObject('resp_r1', [], { status: 'in_progress' }) },
                { type: 'response.output_item.added', output_index: 0, item: { ...reasoningItem, status: 'in_progress' } },
                { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Checking the weather.' },
                { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
                { type: 'response.output_item.done', output_index: 1, item: webSearchItem },
                { type: 'response.output_item.done', output_index: 2, item: xSearchItem },
                textDelta('Let me check.'),
                { type: 'response.output_item.done', output_index: 3, item: messageItem('Let me check.') },
                ...streamedFunctionCall(4, 'call_paris', 'lookup_weather', '{"city":"Paris"}'),
                completed(
                    responseObject('resp_r1', [reasoningItem, webSearchItem, xSearchItem, messageItem('Let me check.'), call], {
                        usage: {
                            input_tokens: 100,
                            output_tokens: 20,
                            output_tokens_details: { reasoning_tokens: 5 },
                            total_tokens: 120,
                            server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 1, x_posts_fetched: 5, code_interpreter_calls: 0 },
                        },
                    })
                ),
            ];
            const citation = { type: 'url_citation', url: 'https://weather.example/paris', title: 'Paris weather', start_index: 0, end_index: 5 };
            const secondRound: EventFixture[] = [
                textDelta('Sunny in Paris.'),
                completed(
                    responseObject('resp_r2', [messageItem('Sunny in Paris.', [citation])], {
                        usage: {
                            input_tokens: 120,
                            output_tokens: 8,
                            output_tokens_details: { reasoning_tokens: 7 },
                            total_tokens: 128,
                            server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 0 },
                        },
                        extra: { previous_response_id: 'resp_r1' },
                    })
                ),
            ];
            reset(scripted(ok(firstRound), ok(secondRound)));

            const { result: chunks } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(recordedRequests.length === 2, `one continuation follows the tool round (got ${recordedRequests.length})`);
            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Paris' } }]),
                `the call runs once with its arguments (got ${json(executions)})`
            );

            const [first, second] = recordedRequests;
            expect(
                json(toolsOf(first)) ===
                    json([
                        ...TODAY_TOOLS,
                        {
                            type: 'function',
                            name: 'lookup_weather',
                            description: 'Look up the weather of a city',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string', description: 'City name' } },
                                required: ['city'],
                                additionalProperties: false,
                            },
                        },
                        { type: 'function', name: 'broken_tool', description: 'Always fails', parameters: { type: 'object', properties: {} } },
                    ]),
                `function tools follow the search tools, without $schema or strict (got ${json(toolsOf(first))})`
            );
            expect(
                first?.body.max_turns === 10 && first.body.parallel_tool_calls === true && !('tool_choice' in first.body),
                `round 1 keeps today's request params (got ${json(Object.keys(first?.body ?? {}))})`
            );
            expect(second?.body.previous_response_id === 'resp_r1', 'the continuation chains to the round-1 response');
            expect(
                json(second?.body.input) ===
                    json([{ type: 'function_call_output', call_id: 'call_paris', output: 'sunny in Paris' }]),
                `its input is one function_call_output per call (got ${json(second?.body.input)})`
            );
            expect(json(toolsOf(second)) === json(toolsOf(first)), 'and it declares the same tools');
            expect(
                second?.body.max_turns === 10 &&
                    second.body.parallel_tool_calls === true &&
                    second.body.model === MODEL &&
                    second.body.stream === true &&
                    !('tool_choice' in second.body) &&
                    !('store' in second.body),
                `with the same params, store left default and tools still on (got ${json(Object.keys(second?.body ?? {}))})`
            );

            expect(
                textOf(chunks) === 'Let me check.\n\nSunny in Paris.',
                `the rounds stream with a blank line between them (got ${json(textOf(chunks))})`
            );
            expect(textOf(chunks, 'thinking') === 'Checking the weather.', 'thinking streams too');
            const statuses = chunks.filter((chunk) => chunk.type === 'status');
            expect(
                statuses.length === 2 &&
                    statuses[0]?.status?.text.includes('lookup_weather') === true &&
                    statuses[1]?.status === undefined,
                `a status while the tool runs, then a clear (got ${json(statuses)})`
            );
            const groundings = chunks.filter((chunk) => chunk.type === 'grounding');
            expect(
                groundings.length === 1 &&
                    json(groundings[0]?.groundingMetadata?.citations) ===
                        json([{ uri: 'https://weather.example/paris', title: 'Paris weather' }]),
                `the answer's citation is reported (got ${json(groundings)})`
            );

            const done = chunks.at(-1);
            expect(chunks.filter((chunk) => chunk.type === 'done').length === 1, 'one done closes the reply');
            expect(
                done?.type === 'done' &&
                    json(done.agentStats?.toolUsage) ===
                        json([
                            { name: 'lookup_weather', count: 1 },
                            { name: 'web_search', count: 1 },
                            { name: 'x_search', count: 1 },
                        ]) &&
                    done.agentStats?.reasoningTokens === 12,
                `done carries server-side and client usage of every round (got ${json(done?.agentStats)})`
            );
            expect(done?.rawResponse === undefined, 'a reply of several rounds keeps exactly what was streamed');
        },
    },
    {
        name: 'grok multi-agent requests carry no function tools',
        body: async () => {
            reset(scripted(answerRound('resp_ma', 'Sixteen agents agree.')));

            const { result: chunks } = await captureConsole(async () => drain(await sendGrok(MULTI_AGENT_MODEL, turnTools)));

            const [request] = recordedRequests;
            expect(recordedRequests.length === 1, 'a single request');
            expect(
                request !== undefined && !hasFunctionTools(request) && json(toolsOf(request)) === json(TODAY_TOOLS),
                `only the search tools are declared (got ${json(toolsOf(request))})`
            );
            expect(json(request?.body.reasoning) === json({ effort: 'high' }), 'reasoning stays on');
            expect(textOf(chunks) === 'Sixteen agents agree.', 'the answer streams');
            const done = chunks.at(-1);
            expect(done?.type === 'done' && done.agentStats?.mode === '16 agents', 'the mode is reported');
            expect(
                new GrokPlatform().getModelCapabilities(MULTI_AGENT_MODEL).supportsClientTools === false &&
                    new GrokPlatform().getModelCapabilities(MODEL).supportsClientTools === true,
                'and the capabilities say so'
            );
        },
    },
    {
        name: 'grok without tools sends exactly today\'s request',
        body: async () => {
            for (const tools of [undefined, NO_TURN_TOOLS]) {
                reset(scripted(answerRound('resp_plain', 'Hello.')));
                const { result: chunks } = await captureConsole(async () => drain(await sendGrok(MODEL, tools)));

                const body = recordedRequests[0]?.body ?? {};
                expect(
                    recordedRequests.length === 1 &&
                        json(Object.keys(body).sort()) ===
                            json(['input', 'max_turns', 'model', 'parallel_tool_calls', 'stream', 'tools']) &&
                        json(body.tools) === json(TODAY_TOOLS) &&
                        body.max_turns === 10 &&
                        body.parallel_tool_calls === true,
                    `${tools ? 'zero definitions' : 'no tools'}: today's request (got ${json(body)})`
                );
                const done = chunks.at(-1);
                expect(
                    textOf(chunks) === 'Hello.' && done?.type === 'done' && asRecord(done.rawResponse).id === 'resp_plain',
                    'the answer streams and done carries its response, as today'
                );
            }
        },
    },
    {
        name: 'a grok candidate downgrade keeps the function tools and is pinned',
        body: async () => {
            reset(
                scripted(
                    badRequest('Argument not supported: max_turns'),
                    toolRound('resp_r1', 'call_1'),
                    answerRound('resp_r2', 'Done.')
                )
            );

            const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(recordedRequests.length === 3, `rejected, accepted, continued (got ${recordedRequests.length})`);
            const [rejected, accepted, continuation] = recordedRequests;
            expect(rejected?.body.max_turns === 10 && rejected !== undefined && hasFunctionTools(rejected), 'the first candidate had everything');
            expect(
                accepted !== undefined && !('max_turns' in accepted.body) && hasFunctionTools(accepted),
                `the downgraded candidate still carries the function tools (got ${json(toolsOf(accepted))})`
            );
            expect(
                continuation !== undefined &&
                    !('max_turns' in continuation.body) &&
                    json(toolsOf(continuation)) === json(toolsOf(accepted)) &&
                    continuation.body.previous_response_id === 'resp_r1',
                'the continuation reuses the accepted candidate, not the first one'
            );
            expect(executions.length === 1 && textOf(chunks) === 'Done.', 'the call ran and the answer streamed');
            expect(lines.some((line) => line.includes('Falling back')), 'the downgrade is logged');
        },
    },
    {
        name: 'the last grok candidate goes without function tools',
        body: async () => {
            reset((request) =>
                hasFunctionTools(request)
                    ? badRequest('Invalid tool definition: parameters rejected')
                    : answerRound('resp_plain', 'Answer without tools.')
            );

            const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            const last = recordedRequests.at(-1);
            expect(
                recordedRequests.length === 6 && recordedRequests.slice(0, -1).every(hasFunctionTools),
                `every search candidate is tried with the function tools first (got ${recordedRequests.length} requests)`
            );
            expect(
                last !== undefined && !hasFunctionTools(last) && json(toolsOf(last)) === json(TODAY_TOOLS) && last.body.max_turns === 10,
                `the last candidate is today's request (got ${json(last?.body)})`
            );
            expect(textOf(chunks) === 'Answer without tools.', 'and it answers');
            expect(
                lines.some((line) => line.startsWith('error') && line.includes('answering without them')),
                `accepting it is logged as an error (got ${json(lines.filter((line) => line.startsWith('error')))})`
            );
            expect(executions.length === 0, 'no tool ran');
        },
    },
    {
        name: 'the thirteenth grok round is the tool-less one',
        body: async () => {
            const toolRounds = 12;
            reset(
                scripted(
                    ...Array.from({ length: toolRounds }, (_, index) =>
                        toolRound(`resp_${index + 1}`, `call_${index + 1}`)
                    ),
                    answerRound(`resp_${toolRounds + 1}`, 'Enough lookups.')
                )
            );

            const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(
                recordedRequests.length === toolRounds + 1,
                `${toolRounds + 1} rounds at most (got ${recordedRequests.length})`
            );
            expect(executions.length === toolRounds, `${toolRounds} tool rounds ran (got ${executions.length})`);
            expect(
                recordedRequests.slice(0, toolRounds).every((request) => !('tool_choice' in request.body)),
                'the tool rounds leave tool_choice alone'
            );
            const finalRequest = recordedRequests[toolRounds];
            expect(
                finalRequest?.body.tool_choice === 'none' &&
                    finalRequest.body.previous_response_id === `resp_${toolRounds}` &&
                    json(finalRequest.body.input) ===
                        json([
                            {
                                type: 'function_call_output',
                                call_id: `call_${toolRounds}`,
                                output: 'sunny in Paris',
                            },
                        ]) &&
                    json(toolsOf(finalRequest)) === json(toolsOf(recordedRequests[0])),
                `the final round switches the declared tools off (got ${json(finalRequest?.body)})`
            );
            expect(lines.some((line) => line.includes('Tool round limit reached')), 'the reason is logged');
            const done = chunks.at(-1);
            expect(
                textOf(chunks) === 'Enough lookups.' &&
                    done?.type === 'done' &&
                    json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: toolRounds }]),
                `the answer streams and the tally covers every round (got ${json(done?.agentStats)})`
            );
        },
    },
    {
        name: 'a grok reply past its deadline closes with tool_choice none',
        body: async () => {
            const parse = (events: readonly EventFixture[]): ResponseStreamEvent[] => JSON.parse(JSON.stringify(events));
            const streamOf = async function* (events: readonly EventFixture[]): AsyncGenerator<ResponseStreamEvent> {
                yield* parse(events);
            };
            const call = functionCallItem('call_1', 'lookup_weather', '{"city":"Paris"}');
            const continuations: Array<Record<string, unknown>> = [];
            executions.length = 0;

            const [acceptedRequest] = buildCandidateRequests(
                { model: MODEL, input: [], stream: true, tools: buildSearchTools(), max_turns: 10, parallel_tool_calls: true },
                toGrokFunctionTools(turnTools.definitions)
            );
            if (!acceptedRequest) throw new Error('no candidate');

            const { result: chunks, lines } = await captureConsole(async () =>
                drain(
                    runGrokToolLoop({
                        model: MODEL,
                        firstStream: streamOf([...streamedFunctionCall(0, 'call_1', 'lookup_weather', '{"city":"Paris"}'), completed(responseObject('resp_1', [call]))]),
                        acceptedRequest,
                        tools: turnTools,
                        startedAt: Date.now(),
                        deadlineMs: 0,
                        openContinuation: async (request) => {
                            continuations.push(JSON.parse(JSON.stringify(request)));
                            return streamOf([textDelta('Out of time.'), completed(responseObject('resp_2', [messageItem('Out of time.')]))]);
                        },
                    })
                )
            );

            expect(continuations.length === 1 && continuations[0]?.tool_choice === 'none', `the next round is the final one (got ${json(continuations)})`);
            expect(lines.some((line) => line.includes('deadline (0s) passed')), 'the deadline is logged');
            expect(executions.length === 1 && textOf(chunks) === 'Out of time.', 'the call ran before the final answer');
        },
    },
    {
        name: 'a grok continuation 400 is an error, not a feature fallback',
        body: async () => {
            reset(scripted(toolRound('resp_r1', 'call_1'), badRequest('Invalid tool output for call_1')));

            const { result: outcome } = await captureConsole(async () => {
                try {
                    await drain(await sendGrok(MODEL, turnTools));
                    return 'finished';
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
            });

            expect(outcome.includes('Invalid tool output'), `the continuation error surfaces (got ${outcome})`);
            expect(recordedRequests.length === 2, `no candidate walk after round 1 (got ${recordedRequests.length})`);
        },
    },
    {
        name: 'grok runs the offered function calls and answers the others with an error',
        body: async () => {
            const known = functionCallItem('call_known', 'lookup_weather', '{"city":"Paris"}');
            const unknown = functionCallItem('call_unknown', 'browse_page', '{"url":"https://example.com"}');
            reset(
                scripted(
                    ok([
                        { type: 'response.output_item.done', output_index: 0, item: xSearchItem },
                        ...streamedFunctionCall(1, 'call_unknown', 'browse_page', '{"url":"https://example.com"}'),
                        ...streamedFunctionCall(2, 'call_known', 'lookup_weather', '{"city":"Paris"}'),
                        completed(responseObject('resp_r1', [xSearchItem, unknown, known])),
                    ]),
                    answerRound('resp_r2', 'Sunny.')
                )
            );

            const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Paris' } }]),
                `only the offered tool runs (got ${json(executions)})`
            );
            expect(
                json(recordedRequests[1]?.body.input) ===
                    json([
                        { type: 'function_call_output', call_id: 'call_unknown', output: 'Error: Unknown tool browse_page' },
                        { type: 'function_call_output', call_id: 'call_known', output: 'sunny in Paris' },
                    ]),
                `every function call is answered, in call order; the server-side call is not (got ${json(recordedRequests[1]?.body.input)})`
            );
            expect(
                lines.some((line) => line.startsWith('warn') && line.includes('not offered this turn with an error: browse_page')),
                'the unoffered name is logged'
            );
            const statuses = chunks.filter((chunk) => chunk.type === 'status');
            const done = chunks.at(-1);
            expect(
                statuses.length === 2 &&
                    statuses[0]?.status?.text.includes('lookup_weather') === true &&
                    done?.type === 'done' &&
                    json(done.agentStats?.toolUsage) ===
                        json([
                            { name: 'lookup_weather', count: 1 },
                            { name: 'x_search', count: 1 },
                        ]),
                `the unoffered call shows no status and is not counted (got ${json(statuses)} / ${json(done?.agentStats)})`
            );

            // A round whose only function call is unoffered is not the answer
            reset(
                scripted(
                    ok([
                        textDelta('Searched X.'),
                        { type: 'response.output_item.done', output_index: 1, item: xSearchItem },
                        ...streamedFunctionCall(2, 'call_unknown', 'browse_page', '{}'),
                        completed(responseObject('resp_only', [messageItem('Searched X.'), xSearchItem, { ...unknown, arguments: '{}' }])),
                    ]),
                    answerRound('resp_after', 'I cannot open pages.')
                )
            );
            const { result: onlyUnofferedChunks } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));
            expect(
                recordedRequests.length === 2 &&
                    recordedRequests[1]?.body.previous_response_id === 'resp_only' &&
                    json(recordedRequests[1]?.body.input) ===
                        json([{ type: 'function_call_output', call_id: 'call_unknown', output: 'Error: Unknown tool browse_page' }]),
                `a round with only unoffered calls continues with their errors (got ${json(recordedRequests[1]?.body)})`
            );
            expect(
                executions.length === 0 &&
                    textOf(onlyUnofferedChunks) === 'Searched X.\n\nI cannot open pages.' &&
                    !onlyUnofferedChunks.some((chunk) => chunk.type === 'status'),
                `nothing runs and the model answers (got ${json(textOf(onlyUnofferedChunks))})`
            );
        },
    },
    {
        name: 'grok never runs a turn tool the accepted request does not declare',
        body: async () => {
            reset((request) => {
                if (hasFunctionTools(request)) return badRequest('Invalid tool definition: parameters rejected');
                return request.body.previous_response_id === undefined
                    ? toolRound('resp_plain', 'call_1')
                    : answerRound('resp_after', 'No weather tool here.');
            });

            const { result: chunks } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            const continuation = recordedRequests.at(-1);
            expect(
                recordedRequests.length === 7 && executions.length === 0,
                `five rejected candidates, the tool-less one, one continuation, and lookup_weather never runs (got ${recordedRequests.length} requests, ${json(executions)})`
            );
            expect(
                continuation !== undefined &&
                    continuation.body.previous_response_id === 'resp_plain' &&
                    json(toolsOf(continuation)) === json(TODAY_TOOLS) &&
                    json(continuation.body.input) ===
                        json([{ type: 'function_call_output', call_id: 'call_1', output: 'Error: Unknown tool lookup_weather' }]),
                `the call is answered with an error on the tool-less chain (got ${json(continuation?.body)})`
            );
            expect(
                textOf(chunks) === 'No weather tool here.' && !chunks.some((chunk) => chunk.type === 'status'),
                'and the model answers'
            );
        },
    },
    {
        name: 'grok runs parallel function calls once each, in output order',
        body: async () => {
            const paris = functionCallItem('call_paris', 'lookup_weather', '{"city":"Paris"}');
            const tokyo = functionCallItem('call_tokyo', 'lookup_weather', '{"city":"Tokyo"}');
            // Interleaved like a parallel stream: the second call finishes first
            const parallelRound = (closingOutput: readonly unknown[]): StubReply =>
                ok([
                    { type: 'response.output_item.added', output_index: 0, item: { ...paris, arguments: '', status: 'in_progress' } },
                    { type: 'response.output_item.added', output_index: 1, item: { ...tokyo, arguments: '', status: 'in_progress' } },
                    { type: 'response.function_call_arguments.delta', item_id: paris.id, output_index: 0, delta: paris.arguments },
                    { type: 'response.function_call_arguments.delta', item_id: tokyo.id, output_index: 1, delta: tokyo.arguments },
                    { type: 'response.output_item.done', output_index: 1, item: tokyo },
                    { type: 'response.output_item.done', output_index: 0, item: paris },
                    completed(responseObject('resp_parallel', closingOutput)),
                ]);
            const variants: Array<{ label: string; closingOutput: readonly unknown[] }> = [
                { label: 'listed by the closing response', closingOutput: [paris, tokyo] },
                { label: 'only streamed', closingOutput: [] },
            ];

            for (const { label, closingOutput } of variants) {
                reset(scripted(parallelRound(closingOutput), answerRound('resp_r2', 'Sunny in both.')));

                const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

                expect(
                    json(executions) ===
                        json([
                            { name: 'lookup_weather', args: { city: 'Paris' } },
                            { name: 'lookup_weather', args: { city: 'Tokyo' } },
                        ]),
                    `${label}: each call runs once with its own arguments, in output order (got ${json(executions)})`
                );
                expect(
                    json(recordedRequests[1]?.body.input) ===
                        json([
                            { type: 'function_call_output', call_id: 'call_paris', output: 'sunny in Paris' },
                            { type: 'function_call_output', call_id: 'call_tokyo', output: 'sunny in Tokyo' },
                        ]),
                    `${label}: the outputs follow the calls with matching call_ids (got ${json(recordedRequests[1]?.body.input)})`
                );
                const done = chunks.at(-1);
                expect(
                    chunks.filter((chunk) => chunk.type === 'status').length === 3 &&
                        done?.type === 'done' &&
                        json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: 2 }]),
                    `${label}: a status per call, one clear, and both calls counted (got ${json(done?.agentStats)})`
                );
                expect(!lines.some((line) => line.includes('differ from the closing response')), `${label}: no mismatch warning`);
            }
        },
    },
    {
        name: 'grok takes the closing response when the stream disagrees',
        body: async () => {
            const paris = functionCallItem('call_paris', 'lookup_weather', '{"city":"Paris"}');
            const tokyo = functionCallItem('call_tokyo', 'lookup_weather', '{"city":"Tokyo"}');
            const parisAnswer = json([{ type: 'function_call_output', call_id: 'call_paris', output: 'sunny in Paris' }]);

            // The stream shows a call the closing response does not list
            reset(
                scripted(
                    ok([
                        { type: 'response.output_item.done', output_index: 0, item: paris },
                        { type: 'response.output_item.done', output_index: 1, item: tokyo },
                        completed(responseObject('resp_r1', [paris])),
                    ]),
                    answerRound('resp_r2', 'Sunny.')
                )
            );
            const { lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));
            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Paris' } }]) &&
                    json(recordedRequests[1]?.body.input) === parisAnswer,
                `only the listed call runs and is answered (got ${json(executions)} / ${json(recordedRequests[1]?.body.input)})`
            );
            expect(
                lines.some((line) => line.startsWith('warn') && line.includes('(2) differ from the closing response (1)')),
                'the mismatch is logged with counts only'
            );

            // The same call under another call_id on the stream (a relay minting its own)
            reset(
                scripted(
                    ok([
                        { type: 'response.output_item.done', output_index: 0, item: { ...paris, call_id: 'relay_paris' } },
                        completed(responseObject('resp_r1', [paris])),
                    ]),
                    answerRound('resp_r2', 'Sunny.')
                )
            );
            await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));
            expect(
                executions.length === 1 && json(recordedRequests[1]?.body.input) === parisAnswer,
                `it runs once, answered under the response's call_id (got ${executions.length} runs, ${json(recordedRequests[1]?.body.input)})`
            );
        },
    },
    {
        name: 'a grok stream that ends without a closing event runs nothing',
        body: async () => {
            reset(
                scripted(
                    ok([textDelta('Let me check.'), ...streamedFunctionCall(1, 'call_1', 'lookup_weather', '{"city":"Paris"}')]),
                    answerRound('resp_r2', 'never sent')
                )
            );

            const { result: chunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(
                recordedRequests.length === 1 && executions.length === 0,
                `no call runs and no round follows (got ${recordedRequests.length} requests, ${executions.length} runs)`
            );
            expect(
                textOf(chunks) === 'Let me check.' && chunks.filter((chunk) => chunk.type === 'done').length === 1 && chunks.at(-1)?.type === 'done',
                'what streamed stays, and one done still closes the reply'
            );
            expect(
                lines.some((line) => line.includes('ended without a closing response, skipping its 1 function call(s)')),
                'the cut is logged'
            );
        },
    },
    {
        name: 'a grok tool error reaches xAI with the Error prefix',
        body: async () => {
            reset(scripted(toolRound('resp_r1', 'call_broken', 'broken_tool', '{}'), answerRound('resp_r2', 'It failed.')));

            await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));

            expect(
                json(recordedRequests[1]?.body.input) ===
                    json([{ type: 'function_call_output', call_id: 'call_broken', output: 'Error: service unavailable' }]),
                `the failure is sent back as text (got ${json(recordedRequests[1]?.body.input)})`
            );
        },
    },
    {
        name: 'grok rounds close on response.incomplete and response.done',
        body: async () => {
            const call = functionCallItem('call_1', 'lookup_weather', '{"city":"Paris"}');
            reset(
                scripted(
                    ok([
                        textDelta('Partial'),
                        ...streamedFunctionCall(1, 'call_1', 'lookup_weather', '{"city":"Paris"}'),
                        {
                            type: 'response.incomplete',
                            response: responseObject('resp_cut', [messageItem('Partial'), call], {
                                status: 'incomplete',
                                extra: { incomplete_details: { reason: 'max_output_tokens' } },
                            }),
                        },
                    ])
                )
            );
            const { result: cutChunks, lines } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));
            expect(
                recordedRequests.length === 1 && executions.length === 0 && textOf(cutChunks) === 'Partial',
                'an incomplete round ends the reply with what streamed'
            );
            expect(cutChunks.at(-1)?.type === 'done', 'and still closes with done');
            expect(lines.some((line) => line.includes('ended incomplete (max_output_tokens)')), 'the reason is logged');

            reset(
                scripted(
                    ok([...streamedFunctionCall(0, 'call_1', 'lookup_weather', '{"city":"Paris"}'), { type: 'response.done', response: responseObject('resp_done', [call]) }]),
                    answerRound('resp_r2', 'Sunny.')
                )
            );
            const { result: doneChunks } = await captureConsole(async () => drain(await sendGrok(MODEL, turnTools)));
            expect(
                recordedRequests[1]?.body.previous_response_id === 'resp_done' && textOf(doneChunks) === 'Sunny.',
                `a round closed by response.done continues like a completed one (got ${json(recordedRequests[1]?.body)})`
            );
        },
    },
    {
        name: 'grok response.failed and error events throw',
        body: async () => {
            const outcomeOf = async (events: readonly EventFixture[]): Promise<string> => {
                reset(scripted(ok(events)));
                const { result } = await captureConsole(async () => {
                    try {
                        await drain(await sendGrok(MODEL, turnTools));
                        return 'finished';
                    } catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                });
                return result;
            };

            const failed = await outcomeOf([
                textDelta('Hi'),
                { type: 'response.failed', response: { ...responseObject('resp_f', [], { status: 'failed' }), error: { code: 'server_error', message: 'upstream exploded' } } },
            ]);
            expect(failed === 'upstream exploded', `response.failed throws its message (got ${failed})`);

            const errored = await outcomeOf([{ type: 'error', code: 'overloaded', message: 'stream broke', param: null, sequence_number: 1 }]);
            expect(errored === 'stream broke', `an error event throws its message (got ${errored})`);
        },
    },
    {
        name: 'grok counts server-side calls from the output items without usage details',
        body: async () => {
            const codeItem = {
                type: 'code_interpreter_call',
                id: 'ci_1',
                status: 'completed',
                outputs: [{ type: 'logs', logs: '\n  42\nmore' }],
            };
            const output = [webSearchItem, { ...webSearchItem, id: 'ws_2' }, xSearchItem, codeItem, messageItem('Found it.')];
            reset(
                scripted(
                    ok([
                        textDelta('Found it.'),
                        completed(responseObject('resp_items', output, { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })),
                    ])
                )
            );

            const { result: chunks } = await captureConsole(async () => drain(await sendGrok(MODEL, undefined)));

            const done = chunks.at(-1);
            expect(
                done?.type === 'done' &&
                    json(done.agentStats?.toolUsage) ===
                        json([
                            { name: 'web_search', count: 2 },
                            { name: 'code_interpreter', count: 1 },
                            { name: 'x_search', count: 1 },
                        ]) &&
                    json(done.agentStats?.codeInterpreterSummary) === json(['1 log block | 42']),
                `custom tool calls count as x_search (got ${json(done?.agentStats)})`
            );
        },
    },
    {
        name: 'a stopped grok reply sends no further round',
        body: async () => {
            const controller = new AbortController();
            const stoppingTool: ToolHandler = {
                definition: weatherTool.definition,
                execute: async (args) => {
                    executions.push({ name: 'lookup_weather', args });
                    controller.abort();
                    return { content: 'sunny', isError: false, images: [], record: null };
                },
            };
            reset(scripted(toolRound('resp_r1', 'call_1'), answerRound('resp_r2', 'never sent')));

            const { result: chunks } = await captureConsole(async () =>
                drain(await sendGrok(MODEL, createTurnTools([stoppingTool]), controller.signal))
            );

            expect(recordedRequests.length === 1 && executions.length === 1, `the tool ran, nothing followed (got ${recordedRequests.length} requests)`);
            const done = chunks.at(-1);
            expect(
                done?.type === 'done' && json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: 1 }]),
                'done still closes the reply with its tally'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
stubServer.closeAllConnections();
stubServer.close();
reportResults(results);
