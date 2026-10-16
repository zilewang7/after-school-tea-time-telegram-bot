/**
 * Offline cases for the client tool loops of the OpenAI, Anthropic, DeepSeek
 * and MiMo platforms, and the shared loop they run on (no containers, no
 * network).
 *
 * Run: pnpm test:offline (or `npx tsx scripts/offline/tools-platforms.mts` alone)
 *
 * Every platform talks to one local stub that replays scripted SSE rounds and
 * records each request body, so the cases can check both what the loop streams
 * and what it sends back to the provider after a tool round.
 */
import { createServer } from 'node:http';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type {
    ResponseFunctionToolCall,
    ResponseOutputItem,
} from 'openai/resources/responses/responses';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult } from '../../src/ai/tools/index.js';

interface ScriptedResponse {
    readonly path: string;
    readonly body: string;
}

interface RecordedRequest {
    readonly path: string;
    readonly body: Record<string, unknown>;
}

/** A stream event as the fixtures write it: typed loosely, the stub only serializes it */
type StreamEventFixture = Readonly<Record<string, unknown>> & { readonly type: string };

const scriptedResponses: ScriptedResponse[] = [];
const recordedRequests: RecordedRequest[] = [];

/** Serve the scripted rounds in order; anything unexpected is a 400 (never retried) */
const stubServer = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on('data', (part: Buffer) => bodyParts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        const rawBody = Buffer.concat(bodyParts).toString('utf8');
        recordedRequests.push({ path, body: rawBody ? JSON.parse(rawBody) : {} });

        const next = scriptedResponses.shift();
        if (!next || next.path !== path) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: `unexpected request to ${path}` } }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(next.body);
    });
});
await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', () => resolve()));
const stubAddress = stubServer.address();
if (stubAddress === null || typeof stubAddress === 'string') {
    throw new Error('the stub server has no TCP address');
}
const stubBaseUrl = `http://127.0.0.1:${stubAddress.port}`;

// The platforms read these in their constructors
process.env.OPENAI_API_URL = `${stubBaseUrl}/v1`;
process.env.OPENAI_API_KEY = 'offline-stub';
process.env.ANTHROPIC_API_URL = stubBaseUrl;
process.env.ANTHROPIC_API_KEY = 'offline-stub';
process.env.DEEPSEEK_API_URL = `${stubBaseUrl}/v1`;
process.env.DEEPSEEK_API_KEY = 'offline-stub';
process.env.MIMO_API_URL = `${stubBaseUrl}/v1`;
process.env.MIMO_API_KEY = 'offline-stub';

const { OpenAIPlatform } = await import('../../src/ai/platforms/openai-platform.js');
const { AnthropicPlatform } = await import('../../src/ai/platforms/anthropic-platform.js');
const { DeepSeekPlatform } = await import('../../src/ai/platforms/deepseek-platform.js');
const { MimoPlatform } = await import('../../src/ai/platforms/mimo-platform.js');
const { createTurnTools, NO_TURN_TOOLS, runToolLoop, createRoundTextSeparator } = await import(
    '../../src/ai/tools/index.js'
);
const { buildToolRoundMessages } = await import('../../src/ai/platforms/openai/responses-tool-round.js');
const { reconcileFunctionCalls } = await import('../../src/ai/platforms/responses/responses-function-calls.js');
const { createChatToolCallCollector } = await import(
    '../../src/ai/platforms/chat-completions/chat-completions-tool-round.js'
);
const { MIMO_CONTENT_FILTER_NOTICE } = await import('../../src/ai/platforms/mimo-content-filter.js');
const { OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');

// ---- fake tools ----

const executions: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];

const WEATHER_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
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

const resetStub = (responses: ScriptedResponse[]): void => {
    scriptedResponses.length = 0;
    scriptedResponses.push(...responses);
    recordedRequests.length = 0;
    executions.length = 0;
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
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
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

const textOf = (chunks: readonly StreamChunk[], type: 'text' | 'thinking' = 'text'): string =>
    chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => chunk.content ?? '')
        .join('');

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

/** `event:` + `data:` lines (Responses API and Anthropic streams) */
const namedEvent = (event: StreamEventFixture): string =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** chat.completions stream line */
const dataLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'offline-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'offline-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const chatBody = (chunks: readonly unknown[]): string => chunks.map(dataLine).join('') + 'data: [DONE]\n\n';

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const json = (value: unknown): string => JSON.stringify(value);

// ---- Responses API (OpenAI) fixtures ----

const functionCallItem = (
    itemId: string,
    callId: string,
    name: string,
    argumentsJson: string,
    status: 'in_progress' | 'completed'
): ResponseFunctionToolCall => ({
    type: 'function_call',
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsJson,
    status,
});

const responseObject = (status: string, output: unknown[]) => ({
    id: 'resp_offline',
    object: 'response',
    created_at: 0,
    status,
    model: 'gpt-6-luna',
    output,
    error: null,
});

/** One function call streamed the way the Responses API does it */
const streamedFunctionCall = (
    outputIndex: number,
    itemId: string,
    callId: string,
    argumentPieces: string[]
): StreamEventFixture[] => {
    const fullArguments = argumentPieces.join('');
    return [
        {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: functionCallItem(itemId, callId, 'lookup_weather', '', 'in_progress'),
        },
        ...argumentPieces.map((piece) => ({
            type: 'response.function_call_arguments.delta',
            item_id: itemId,
            output_index: outputIndex,
            delta: piece,
        })),
        {
            type: 'response.function_call_arguments.done',
            item_id: itemId,
            output_index: outputIndex,
            arguments: fullArguments,
        },
        {
            type: 'response.output_item.done',
            output_index: outputIndex,
            item: functionCallItem(itemId, callId, 'lookup_weather', fullArguments, 'completed'),
        },
    ];
};

/** A round that only answers with text */
const responsesAnswerBody = (text: string): string =>
    [
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
        { type: 'response.completed', response: responseObject('completed', []) },
    ]
        .map(namedEvent)
        .join('');

/** A round that calls lookup_weather once */
const responsesToolRoundBody = (round: number): string => {
    const item = functionCallItem(`fc_${round}`, `call_${round}`, 'lookup_weather', `{"city":"C${round}"}`, 'completed');
    return [
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: responseObject('completed', [item]) },
    ]
        .map(namedEvent)
        .join('');
};

// ---- Anthropic Messages fixtures ----

const messageStart: StreamEventFixture = {
    type: 'message_start',
    message: {
        id: 'msg_offline',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
    },
};

const messagesAnswerBody = (text: string): string =>
    [
        messageStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
    ]
        .map(namedEvent)
        .join('');

/** One tool_use turn; `stopReason` other than tool_use cuts the turn short */
const messagesToolRoundBody = (round: number, inputJson = `{"city":"C${round}"}`, stopReason = 'tool_use'): string =>
    [
        messageStart,
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: `toolu_${round}`, name: 'lookup_weather', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
    ]
        .map(namedEvent)
        .join('');

// ---- chat.completions (DeepSeek / MiMo) fixtures ----

const chatToolRoundBody = (round: number): string =>
    chatBody([
        chatChunk({
            tool_calls: [
                {
                    index: 0,
                    id: `call_${round}`,
                    type: 'function',
                    function: { name: 'lookup_weather', arguments: `{"city":"C${round}"}` },
                },
            ],
        }),
        chatChunk({}, 'tool_calls'),
    ]);

const chatAnswerBody = (text: string): string => chatBody([chatChunk({ content: text }), chatChunk({}, 'stop')]);

// ---- round limit, shared by every platform ----

interface RoundLimitSpec {
    readonly label: string;
    readonly path: string;
    readonly maxToolRounds: number;
    readonly toolRoundBody: (round: number) => string;
    readonly finalBody: string;
    readonly send: () => Promise<AsyncIterable<StreamChunk>>;
    /** A tool round's request offers the tools */
    readonly offersTools: (body: Record<string, unknown>) => boolean;
    /** The final request takes them away */
    readonly forbidsTools: (body: Record<string, unknown>) => boolean;
}

const expectRoundLimit = async (spec: RoundLimitSpec): Promise<void> => {
    resetStub([
        ...Array.from({ length: spec.maxToolRounds }, (_, round) => ({ path: spec.path, body: spec.toolRoundBody(round) })),
        { path: spec.path, body: spec.finalBody },
    ]);
    const { result: chunks, lines } = await captureConsole(async () => drain(await spec.send()));

    expect(executions.length === spec.maxToolRounds, `${spec.label}: ${spec.maxToolRounds} tool rounds run (got ${executions.length})`);
    expect(
        recordedRequests.length === spec.maxToolRounds + 1,
        `${spec.label}: one final request follows (got ${recordedRequests.length})`
    );
    expect(
        recordedRequests.slice(0, -1).every((request) => spec.offersTools(request.body)),
        `${spec.label}: every tool round offers the tools`
    );
    const finalRequest = recordedRequests.at(-1)?.body ?? {};
    expect(
        spec.forbidsTools(finalRequest),
        `${spec.label}: the final request takes the tools away (got ${json(Object.keys(finalRequest))})`
    );
    expect(lines.some((line) => line.includes('Tool round limit reached')), `${spec.label}: the reason is logged`);
    const done = chunks.at(-1);
    expect(
        textOf(chunks) === 'Enough lookups.' &&
            done?.type === 'done' &&
            json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: spec.maxToolRounds }]),
        `${spec.label}: the final answer streams and the tally covers every round (got ${json(done)})`
    );
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'openai keys parallel function calls by output_index and runs each once',
        body: async () => {
            const parisCall = functionCallItem('fc_1', 'call_paris', 'lookup_weather', '{"city":"Paris"}', 'completed');
            const tokyoCall = functionCallItem('fc_2', 'call_tokyo', 'lookup_weather', '{"city":"Tokyo"}', 'completed');
            const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
            const toolRound: StreamEventFixture[] = [
                { type: 'response.created', response: responseObject('in_progress', []) },
                { type: 'response.output_item.added', output_index: 0, item: reasoningItem },
                {
                    type: 'response.reasoning_summary_text.delta',
                    item_id: 'rs_1',
                    output_index: 0,
                    summary_index: 0,
                    delta: 'Two cities, two lookups.',
                },
                { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
                ...streamedFunctionCall(1, 'fc_1', 'call_paris', ['{"city":', '"Paris"}']),
                ...streamedFunctionCall(2, 'fc_2', 'call_tokyo', ['{"city":', '"Tokyo"}']),
                {
                    type: 'response.completed',
                    response: responseObject('completed', [reasoningItem, parisCall, tokyoCall]),
                },
            ];
            resetStub([
                { path: '/v1/responses', body: toolRound.map(namedEvent).join('') },
                { path: '/v1/responses', body: responsesAnswerBody('Both are sunny.') },
            ]);

            const platform = new OpenAIPlatform();
            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await platform.sendMessage(userTurn('Weather in Paris and Tokyo?'), {
                        model: 'gpt-6-luna',
                        systemPrompt: 'offline persona',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );

            expect(
                json(executions) ===
                    json([
                        { name: 'lookup_weather', args: { city: 'Paris' } },
                        { name: 'lookup_weather', args: { city: 'Tokyo' } },
                    ]),
                `each parallel call runs exactly once with its own arguments (got ${json(executions)})`
            );
            expect(textOf(chunks) === 'Both are sunny.', `the answer streams through (got ${json(textOf(chunks))})`);

            const firstRequest = recordedRequests[0]?.body ?? {};
            const declaredTools = asArray(firstRequest.tools).map(asRecord);
            expect(
                json(declaredTools.map((tool) => [tool.type, tool.name, tool.strict])) ===
                    json([['function', 'lookup_weather', false], ['function', 'broken_tool', false]]),
                `tools go out as Responses function tools with strict:false (got ${json(declaredTools)})`
            );
            expect(
                !('$schema' in asRecord(declaredTools[0]?.parameters)),
                'the $schema key is stripped from the parameters'
            );
            expect(!('reasoning' in firstRequest), 'tool rounds carry no reasoning params');

            const continuation = asArray(recordedRequests[1]?.body.input).map(asRecord).slice(-3);
            expect(
                json(continuation.map((message) => [message.role, message.content])) ===
                    json([
                        ['assistant', '[Called tools]\n\n1. lookup_weather({"city":"Paris"})\n2. lookup_weather({"city":"Tokyo"})'],
                        ['developer', 'Tool #1 "lookup_weather" result:\nsunny in Paris'],
                        ['developer', 'Tool #2 "lookup_weather" result:\nsunny in Tokyo'],
                    ]),
                `the round goes back as numbered messages (got ${json(continuation)})`
            );

            const statuses = chunks.filter((chunk) => chunk.type === 'status');
            expect(
                statuses.length === 3 && statuses[2]?.status === undefined,
                `a status per call, then one clear (got ${json(statuses)})`
            );
            const done = chunks.at(-1);
            expect(
                done?.type === 'done' &&
                    json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: 2 }]) &&
                    asRecord(done.rawResponse).id === 'resp_offline',
                `done carries the tally and the answering response (got ${json(done)})`
            );
        },
    },
    {
        name: 'openai takes the completed response as the final word on its calls',
        body: async () => {
            const callA = functionCallItem('fc_a', 'call_a', 'lookup_weather', '{"city":"A"}', 'completed');
            const callB = functionCallItem('fc_b', 'call_b', 'lookup_weather', '{"city":"B"}', 'completed');
            const reasoning: ResponseOutputItem = { type: 'reasoning', id: 'rs', summary: [] };
            const callIdsOf = (calls: ReadonlyArray<{ item: { call_id: string } }>): string =>
                json(calls.map((indexedCall) => indexedCall.item.call_id));

            const { result: outcomes, lines } = await captureConsole(async () => ({
                clean: reconcileFunctionCalls(new Map([[1, callA], [2, callB]]), [reasoning, callA, callB], '[openai]'),
                // A relay that reports every item at output_index 0 overwrites call A in the stream map
                collided: reconcileFunctionCalls(new Map([[0, callB]]), [callA, callB], '[openai]'),
                streamOnly: reconcileFunctionCalls(new Map([[1, callA], [2, callB]]), undefined, '[openai]'),
                emptyCompleted: reconcileFunctionCalls(new Map([[1, callA]]), [], '[openai]'),
                // The two sides disagree on the call_id: still one call
                streamWithoutId: reconcileFunctionCalls(new Map([[1, { ...callA, call_id: '' }]]), [reasoning, callA], '[openai]'),
                relayMintedId: reconcileFunctionCalls(new Map([[0, { ...callA, call_id: 'call_relay' }]]), [callA], '[openai]'),
            }));
            expect(callIdsOf(outcomes.clean) === json(['call_a', 'call_b']), `matching sources give each call once (got ${callIdsOf(outcomes.clean)})`);
            expect(callIdsOf(outcomes.collided) === json(['call_a', 'call_b']), `the completed output restores a lost call (got ${callIdsOf(outcomes.collided)})`);
            expect(callIdsOf(outcomes.streamOnly) === json(['call_a', 'call_b']), 'without a completed response the stream is used');
            expect(callIdsOf(outcomes.emptyCompleted) === json(['call_a']), 'an empty completed output never drops a streamed call');
            expect(
                callIdsOf(outcomes.streamWithoutId) === json(['call_a']),
                `a call streamed without call_id is listed once (got ${callIdsOf(outcomes.streamWithoutId)})`
            );
            expect(
                callIdsOf(outcomes.relayMintedId) === json(['call_a']),
                `so is one whose call_id differs on the two sides (got ${callIdsOf(outcomes.relayMintedId)})`
            );
            expect(
                lines.filter((line) => line.startsWith('[openai]') && line.includes('differ from the closing response')).length === 1 &&
                    lines.every((line) => !line.includes('"city"')),
                `only the real mismatch is logged, without arguments (got ${json(lines)})`
            );

            const messages = buildToolRoundMessages('Let me check.', [
                {
                    call: { id: 'call_x', name: 'broken_tool', argumentsJson: '{}' },
                    result: { content: 'service unavailable', isError: true, images: [], record: null } satisfies ToolResult,
                },
            ]);
            expect(
                json(messages.map((message) => message.content)) ===
                    json(['Let me check.\n\n1. broken_tool({})', 'Tool #1 "broken_tool" result:\nError: service unavailable']),
                `the round text is kept and errors are prefixed (got ${json(messages)})`
            );
        },
    },
    {
        name: 'openai runs a call once when the stream lacks its call_id',
        body: async () => {
            const streamed = functionCallItem('fc_lima', '', 'lookup_weather', '{"city":"Lima"}', 'completed');
            const completed = functionCallItem('fc_lima', 'call_lima', 'lookup_weather', '{"city":"Lima"}', 'completed');
            const toolRound: StreamEventFixture[] = [
                { type: 'response.output_item.done', output_index: 1, item: streamed },
                {
                    type: 'response.completed',
                    response: responseObject('completed', [{ type: 'reasoning', id: 'rs_1', summary: [] }, completed]),
                },
            ];
            resetStub([
                { path: '/v1/responses', body: toolRound.map(namedEvent).join('') },
                { path: '/v1/responses', body: responsesAnswerBody('Lima is sunny.') },
            ]);

            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await new OpenAIPlatform().sendMessage(userTurn('Weather in Lima?'), {
                        model: 'gpt-6-luna',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );
            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Lima' } }]),
                `the call runs exactly once (got ${json(executions)})`
            );
            expect(textOf(chunks) === 'Lima is sunny.', 'and the answer follows');
        },
    },
    {
        name: 'anthropic maps is_error from the result and replays redacted thinking',
        body: async () => {
            const toolRound: StreamEventFixture[] = [
                messageStart,
                { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weather first.' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-offline' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-blob' } },
                { type: 'content_block_stop', index: 1 },
                { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Checking now.' } },
                { type: 'content_block_stop', index: 2 },
                {
                    type: 'content_block_start',
                    index: 3,
                    content_block: { type: 'tool_use', id: 'toolu_weather', name: 'lookup_weather', input: {} },
                },
                { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"city": "Pa' } },
                { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: 'ris"}' } },
                { type: 'content_block_stop', index: 3 },
                {
                    type: 'content_block_start',
                    index: 4,
                    content_block: { type: 'tool_use', id: 'toolu_broken', name: 'broken_tool', input: {} },
                },
                { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{}' } },
                { type: 'content_block_stop', index: 4 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } },
                { type: 'message_stop' },
            ];
            resetStub([
                { path: '/v1/messages', body: toolRound.map(namedEvent).join('') },
                { path: '/v1/messages', body: messagesAnswerBody('Paris is sunny.') },
            ]);

            const platform = new AnthropicPlatform();
            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await platform.sendMessage(userTurn('Weather in Paris?'), {
                        model: 'claude-sonnet-5',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );

            expect(
                json(executions) ===
                    json([
                        { name: 'lookup_weather', args: { city: 'Paris' } },
                        { name: 'broken_tool', args: {} },
                    ]),
                `both calls run once, in order (got ${json(executions)})`
            );
            expect(
                textOf(chunks) === 'Checking now.\n\nParis is sunny.',
                `the text of the two rounds is shown a blank line apart (got ${json(textOf(chunks))})`
            );

            const declaredTool = asRecord(asArray(recordedRequests[0]?.body.tools)[0]);
            const inputSchema = asRecord(declaredTool.input_schema);
            expect(
                inputSchema.type === 'object' && !('$schema' in inputSchema),
                `input_schema is an object schema without $schema (got ${json(inputSchema)})`
            );

            const replayed = asArray(recordedRequests[1]?.body.messages).map(asRecord).slice(-2);
            const assistantBlocks = asArray(replayed[0]?.content).map(asRecord);
            expect(
                replayed[0]?.role === 'assistant' &&
                    json(assistantBlocks.map((block) => block.type)) ===
                        json(['thinking', 'redacted_thinking', 'text', 'tool_use', 'tool_use']),
                `the assistant turn is replayed block for block (got ${json(assistantBlocks)})`
            );
            expect(
                assistantBlocks[0]?.signature === 'sig-offline' && assistantBlocks[1]?.data === 'opaque-blob',
                'thinking keeps its signature and redacted_thinking its data'
            );
            expect(assistantBlocks[2]?.text === 'Checking now.', 'the replayed text stays verbatim');
            expect(
                json(assistantBlocks[3]?.input) === json({ city: 'Paris' }),
                `the tool_use input is the parsed streamed JSON (got ${json(assistantBlocks[3])})`
            );

            const toolResults = asArray(replayed[1]?.content).map(asRecord);
            expect(
                replayed[1]?.role === 'user' &&
                    json(toolResults.map((block) => [block.type, block.tool_use_id, block.is_error, block.content])) ===
                        json([
                            ['tool_result', 'toolu_weather', false, 'sunny in Paris'],
                            ['tool_result', 'toolu_broken', true, 'Error: service unavailable'],
                        ]),
                `is_error comes from each result (got ${json(toolResults)})`
            );
        },
    },
    {
        name: 'anthropic replays broken tool input as {} and never logs it',
        body: async () => {
            resetStub([
                { path: '/v1/messages', body: messagesToolRoundBody(0, '{"city": "secret-cit') },
                { path: '/v1/messages', body: messagesAnswerBody('Sorry, that failed.') },
            ]);
            const { result: chunks, lines } = await captureConsole(async () =>
                drain(
                    await new AnthropicPlatform().sendMessage(userTurn('Weather?'), {
                        model: 'claude-sonnet-5',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );

            expect(executions.length === 0, 'the broken call never reaches the tool');
            const replayed = asArray(recordedRequests[1]?.body.messages).map(asRecord).slice(-2);
            const toolUse = asRecord(asArray(replayed[0]?.content)[0]);
            expect(toolUse.type === 'tool_use' && json(toolUse.input) === '{}', `the replayed tool_use carries {} (got ${json(toolUse)})`);
            const toolResult = asRecord(asArray(replayed[1]?.content)[0]);
            expect(
                toolResult.is_error === true &&
                    String(toolResult.content).startsWith('Error: Invalid arguments for lookup_weather'),
                `the model reads an error result (got ${json(toolResult)})`
            );
            expect(lines.every((line) => !line.includes('secret-cit')), 'no log line quotes the input');
            expect(
                lines.some((line) => line.includes('Invalid tool input JSON for lookup_weather')),
                'the bad input is reported by its length only'
            );
            expect(textOf(chunks) === 'Sorry, that failed.', 'the turn still ends with an answer');
        },
    },
    {
        name: 'anthropic only runs tools for a turn that stopped for tool_use',
        body: async () => {
            resetStub([{ path: '/v1/messages', body: messagesToolRoundBody(0, '{"city":"Cut"}', 'max_tokens') }]);
            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await new AnthropicPlatform().sendMessage(userTurn('Weather?'), {
                        model: 'claude-sonnet-5',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );
            expect(
                executions.length === 0 && recordedRequests.length === 1 && chunks.at(-1)?.type === 'done',
                `a max_tokens cut is the answer, its half tool_use never runs (got ${json({ executions, requests: recordedRequests.length })})`
            );
        },
    },
    {
        name: 'deepseek sends reasoning_content back with the tool calls',
        body: async () => {
            const toolRound = [
                chatChunk({ role: 'assistant', content: null, reasoning_content: 'Need the ' }),
                chatChunk({ reasoning_content: 'weather.' }),
                chatChunk({ content: 'Checking.' }),
                chatChunk({
                    tool_calls: [
                        { index: 0, id: 'call_oslo', type: 'function', function: { name: 'lookup_weather', arguments: '' } },
                    ],
                }),
                chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
                chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
                chatChunk({}, 'tool_calls'),
            ];
            const answerRound = [
                chatChunk({ reasoning_content: 'Got it.' }),
                chatChunk({ content: 'Oslo is sunny.' }),
                chatChunk({}, 'stop'),
            ];
            resetStub([
                { path: '/v1/chat/completions', body: chatBody(toolRound) },
                { path: '/v1/chat/completions', body: chatBody(answerRound) },
            ]);

            const platform = new DeepSeekPlatform();
            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await platform.sendMessage(userTurn('Weather in Oslo?'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );

            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Oslo' } }]),
                `the streamed call runs once (got ${json(executions)})`
            );
            expect(
                textOf(chunks) === 'Checking.\n\nOslo is sunny.',
                `text streams through, a blank line between rounds (got ${json(textOf(chunks))})`
            );
            expect(
                textOf(chunks, 'thinking') === 'Need the weather.Got it.',
                `thinking streams through untouched (got ${json(textOf(chunks, 'thinking'))})`
            );

            const declaredTool = asRecord(asArray(recordedRequests[0]?.body.tools)[0]);
            expect(
                declaredTool.type === 'function' &&
                    !('$schema' in asRecord(asRecord(declaredTool.function).parameters)),
                `tools go out as chat.completions function tools without $schema (got ${json(declaredTool)})`
            );

            const continuation = asArray(recordedRequests[1]?.body.messages).map(asRecord).slice(-2);
            expect(
                continuation[0]?.role === 'assistant' &&
                    continuation[0]?.reasoning_content === 'Need the weather.' &&
                    continuation[0]?.content === 'Checking.' &&
                    json(continuation[0]?.tool_calls) ===
                        json([{ id: 'call_oslo', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Oslo"}' } }]),
                `the assistant message carries reasoning_content and the call, text verbatim (got ${json(continuation[0])})`
            );
            expect(
                json(continuation[1]) === json({ role: 'tool', tool_call_id: 'call_oslo', content: 'sunny in Oslo' }),
                `the tool message answers the same call id (got ${json(continuation[1])})`
            );
        },
    },
    {
        name: 'without turn tools every platform keeps its plain request',
        body: async () => {
            const plainChatBody = chatAnswerBody('Hello.');
            resetStub([
                { path: '/v1/responses', body: responsesAnswerBody('Hello.') },
                { path: '/v1/messages', body: messagesAnswerBody('Hello.') },
                { path: '/v1/chat/completions', body: plainChatBody },
                { path: '/v1/chat/completions', body: plainChatBody },
                { path: '/v1/chat/completions', body: plainChatBody },
            ]);

            const { result: replies } = await captureConsole(async () => [
                await drain(
                    await new OpenAIPlatform().sendMessage(userTurn('Hi'), {
                        model: 'gpt-6-luna',
                        systemPrompt: 'offline persona',
                        timeout: 20000,
                    })
                ),
                await drain(
                    await new AnthropicPlatform().sendMessage(userTurn('Hi'), {
                        model: 'claude-sonnet-5',
                        timeout: 20000,
                        tools: NO_TURN_TOOLS,
                    })
                ),
                await drain(
                    await new DeepSeekPlatform().sendMessage(userTurn('Hi'), { model: 'deepseek-flash', timeout: 20000 })
                ),
                await drain(
                    await new DeepSeekPlatform().sendMessage(userTurn('Hi'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        tools: NO_TURN_TOOLS,
                    })
                ),
                await drain(
                    await new MimoPlatform().sendMessage(userTurn('Hi'), {
                        model: 'mimo-v2.6-flash',
                        timeout: 20000,
                        tools: NO_TURN_TOOLS,
                    })
                ),
            ]);

            expect(
                replies.every((chunks) => textOf(chunks) === 'Hello.' && chunks.at(-1)?.type === 'done'),
                `every plain reply streams through (got ${json(replies.map((chunks) => textOf(chunks)))})`
            );
            expect(
                recordedRequests.length === 5 && recordedRequests.every((request) => !('tools' in request.body)),
                `no tools are declared when the turn offers none (got ${json(recordedRequests.map((request) => Object.keys(request.body)))})`
            );
            expect(
                json(recordedRequests[0]?.body.reasoning) === json({ effort: 'xhigh', summary: 'detailed' }),
                `the plain OpenAI request keeps its reasoning params (got ${json(recordedRequests[0]?.body.reasoning)})`
            );
            expect(executions.length === 0, 'no tool runs');
        },
    },
    {
        name: 'mimo runs tools from the turn and still fails a filtered tool round',
        body: async () => {
            const toolRound = [
                chatChunk({ role: 'assistant', content: '', reasoning_content: 'Look it up.' }),
                chatChunk({
                    tool_calls: [
                        { index: 0, id: 'call_rome', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Rome"}' } },
                    ],
                }),
                chatChunk({}, 'tool_calls'),
            ];
            // The answer ends on a fragment that could still have been the filter notice
            const answerRound = [chatChunk({ content: 'Rome is sunny. ' }), chatChunk({ content: 'The' }), chatChunk({}, 'stop')];
            resetStub([
                { path: '/v1/chat/completions', body: chatBody(toolRound) },
                { path: '/v1/chat/completions', body: chatBody(answerRound) },
            ]);

            const platform = new MimoPlatform();
            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await platform.sendMessage(userTurn('Weather in Rome?'), {
                        model: 'mimo-v2.6-flash',
                        timeout: 20000,
                        tools: turnTools,
                    })
                )
            );

            expect(
                json(executions) === json([{ name: 'lookup_weather', args: { city: 'Rome' } }]) &&
                    textOf(chunks) === 'Rome is sunny. The',
                `the call runs once and the whole answer streams, its held tail included (got ${json({ executions, text: textOf(chunks) })})`
            );
            const firstRequest = recordedRequests[0]?.body ?? {};
            expect(
                json(firstRequest.thinking) === json({ type: 'enabled' }) &&
                    asArray(firstRequest.tools).length === 2,
                `thinking mode and both tools are requested (got ${json(Object.keys(firstRequest))})`
            );
            const continuation = asArray(recordedRequests[1]?.body.messages).map(asRecord).slice(-2);
            expect(
                continuation[0]?.reasoning_content === 'Look it up.' &&
                    continuation[0]?.content === null &&
                    continuation[1]?.content === 'sunny in Rome',
                `reasoning_content and the result go back (got ${json(continuation)})`
            );

            resetStub([
                {
                    path: '/v1/chat/completions',
                    body: chatBody([chatChunk({ content: MIMO_CONTENT_FILTER_NOTICE }, 'content_filter')]),
                },
            ]);
            const { result: blocked } = await captureConsole(async () => {
                const blockedChunks: StreamChunk[] = [];
                try {
                    const blockedStream = await platform.sendMessage(userTurn('Weather in Rome?'), {
                        model: 'mimo-v2.6-flash',
                        timeout: 20000,
                        tools: turnTools,
                    });
                    for await (const chunk of blockedStream) {
                        blockedChunks.push(chunk);
                    }
                    return { error: '', text: textOf(blockedChunks) };
                } catch (error) {
                    return { error: error instanceof Error ? error.message : String(error), text: textOf(blockedChunks) };
                }
            });
            expect(
                blocked.error.includes('风控') && blocked.text === '',
                `a filtered tool round ends as the readable error (got ${json(blocked)})`
            );
        },
    },
    {
        name: 'openai stops offering tools after the round limit',
        body: () =>
            expectRoundLimit({
                label: 'openai',
                path: '/v1/responses',
                maxToolRounds: 5,
                toolRoundBody: responsesToolRoundBody,
                finalBody: responsesAnswerBody('Enough lookups.'),
                send: () =>
                    new OpenAIPlatform().sendMessage(userTurn('Keep looking'), {
                        model: 'gpt-6-luna',
                        timeout: 20000,
                        tools: turnTools,
                    }),
                offersTools: (body) => asArray(body.tools).length === 2,
                forbidsTools: (body) => {
                    const lastInput = asRecord(asArray(body.input).at(-1));
                    return (
                        !('tools' in body) &&
                        lastInput.role === 'developer' &&
                        String(lastInput.content).startsWith('Tool call budget is exhausted')
                    );
                },
            }),
    },
    {
        name: 'anthropic stops offering tools after the round limit',
        body: () =>
            expectRoundLimit({
                label: 'anthropic',
                path: '/v1/messages',
                maxToolRounds: 5,
                toolRoundBody: (round) => messagesToolRoundBody(round),
                finalBody: messagesAnswerBody('Enough lookups.'),
                send: () =>
                    new AnthropicPlatform().sendMessage(userTurn('Keep looking'), {
                        model: 'claude-sonnet-5',
                        timeout: 20000,
                        tools: turnTools,
                    }),
                offersTools: (body) => asArray(body.tools).length === 2 && !('tool_choice' in body),
                forbidsTools: (body) => json(body.tool_choice) === json({ type: 'none' }) && asArray(body.tools).length === 2,
            }),
    },
    {
        name: 'deepseek stops offering tools after the round limit',
        body: () =>
            expectRoundLimit({
                label: 'deepseek',
                path: '/v1/chat/completions',
                maxToolRounds: 5,
                toolRoundBody: chatToolRoundBody,
                finalBody: chatAnswerBody('Enough lookups.'),
                send: () =>
                    new DeepSeekPlatform().sendMessage(userTurn('Keep looking'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        tools: turnTools,
                    }),
                offersTools: (body) => asArray(body.tools).length === 2 && !('tool_choice' in body),
                forbidsTools: (body) => body.tool_choice === 'none',
            }),
    },
    {
        name: 'mimo stops offering tools after its ten rounds, and a filtered final round still fails',
        body: async () => {
            const sendToMimo = () =>
                new MimoPlatform().sendMessage(userTurn('Keep looking'), {
                    model: 'mimo-v2.6-flash',
                    timeout: 20000,
                    tools: turnTools,
                });
            await expectRoundLimit({
                label: 'mimo',
                path: '/v1/chat/completions',
                maxToolRounds: 10,
                toolRoundBody: chatToolRoundBody,
                finalBody: chatAnswerBody('Enough lookups.'),
                send: sendToMimo,
                offersTools: (body) => asArray(body.tools).length === 2 && !('tool_choice' in body),
                forbidsTools: (body) => body.tool_choice === 'none' && json(body.thinking) === json({ type: 'enabled' }),
            });

            resetStub([
                ...Array.from({ length: 10 }, (_, round) => ({ path: '/v1/chat/completions', body: chatToolRoundBody(round) })),
                {
                    path: '/v1/chat/completions',
                    body: chatBody([chatChunk({ content: MIMO_CONTENT_FILTER_NOTICE }, 'content_filter')]),
                },
            ]);
            const { result: failure } = await captureConsole(async () =>
                drain(await sendToMimo()).then(
                    () => 'no error',
                    (error: Error) => error.message
                )
            );
            expect(failure.includes('风控'), `the filtered final round ends as the readable error (got ${json(failure)})`);
        },
    },
    {
        name: 'a stop during a tool call runs nothing further and sends no more requests',
        body: async () => {
            const stopController = new AbortController();
            const stoppingTool: ToolHandler = {
                definition: { name: 'slow_tool', description: 'Pressing stop happens here', inputSchema: { type: 'object' } },
                execute: async (args) => {
                    executions.push({ name: 'slow_tool', args });
                    stopController.abort();
                    return { content: 'done', isError: false, images: [], record: null };
                },
            };
            const stoppingTools = createTurnTools([stoppingTool, weatherTool]);
            const toolRound = [
                chatChunk({
                    tool_calls: [
                        { index: 0, id: 'call_slow', type: 'function', function: { name: 'slow_tool', arguments: '{}' } },
                        { index: 1, id: 'call_next', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"X"}' } },
                    ],
                }),
                chatChunk({}, 'tool_calls'),
            ];
            resetStub([{ path: '/v1/chat/completions', body: chatBody(toolRound) }]);

            const { result: chunks } = await captureConsole(async () =>
                drain(
                    await new DeepSeekPlatform().sendMessage(userTurn('Go'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        signal: stopController.signal,
                        tools: stoppingTools,
                    })
                )
            );

            expect(
                json(executions.map((execution) => execution.name)) === json(['slow_tool']),
                `the call after the stop never runs (got ${json(executions)})`
            );
            expect(recordedRequests.length === 1, `no request follows the stop (got ${recordedRequests.length})`);
            expect(chunks.at(-1)?.type === 'done', 'the stream still ends with done');
        },
    },
    {
        name: 'the shared tool loop gives up tools once the deadline has passed',
        body: async () => {
            resetStub([]);
            const finalFlags: boolean[] = [];
            const { result: chunks, lines } = await captureConsole(async () =>
                drain(
                    runToolLoop({
                        tools: turnTools,
                        maxToolRounds: 5,
                        deadlineMs: 50,
                        logPrefix: '[offline]',
                        sendRound: async (roundIndex, final) => {
                            finalFlags.push(final);
                            if (final) return { chunks: [{ type: 'text', content: 'Out of time.' }], toolCalls: [] };
                            // The first round eats the whole budget
                            await new Promise((resolve) => setTimeout(resolve, 80));
                            return {
                                chunks: [{ type: 'text', content: 'Let me check.' }],
                                toolCalls: [{ id: `call_${roundIndex}`, name: 'lookup_weather', argumentsJson: '{"city":"Oslo"}' }],
                            };
                        },
                        appendRound: () => undefined,
                    })
                )
            );
            expect(json(finalFlags) === json([false, true]), `after the deadline the next round is the final one (got ${json(finalFlags)})`);
            expect(executions.length === 1, 'the call made before the deadline still runs');
            expect(
                textOf(chunks) === 'Let me check.\n\nOut of time.',
                `the rounds show a blank line apart (got ${json(textOf(chunks))})`
            );
            expect(lines.some((line) => line.includes('[offline] Tool loop deadline (0s) passed')), `the reason is logged (got ${json(lines)})`);
            const done = chunks.at(-1);
            expect(
                done?.type === 'done' && json(done.agentStats?.toolUsage) === json([{ name: 'lookup_weather', count: 1 }]),
                `one done with the tally (got ${json(done)})`
            );
        },
    },
    {
        name: 'consecutive rounds show their text a blank line apart',
        body: async () => {
            const separator = createRoundTextSeparator();
            const show = (chunk: StreamChunk): string => separator.apply(chunk).content ?? '';

            separator.startRound();
            const first = [show({ type: 'thinking', content: 'hmm' }), show({ type: 'text', content: '  ' }), show({ type: 'text', content: 'A' })];
            separator.startRound();
            const second = [show({ type: 'thinking', content: 'more' }), show({ type: 'text', content: 'B' }), show({ type: 'text', content: 'C' })];
            // A round that shows no text, then one that does
            separator.startRound();
            separator.startRound();
            const fourth = [show({ type: 'text', content: 'D' })];

            expect(json(first) === json(['hmm', '  ', 'A']), `nothing changes before any text was shown (got ${json(first)})`);
            expect(
                json(second) === json(['more', '\n\nB', 'C']),
                `only the first visible text of a later round gets the blank line (got ${json(second)})`
            );
            expect(json(fourth) === json(['\n\nD']), `a round without text adds no second one (got ${json(fourth)})`);
        },
    },
    {
        name: 'chat.completions tool calls without an id get a stable synthesized one',
        body: async () => {
            const collector = createChatToolCallCollector();
            collector.add([{ index: 1, function: { name: 'lookup_weather', arguments: '{"city":"B"}' } }]);
            collector.add([{ index: 0, function: { name: 'lookup_weather', arguments: '{"city":' } }]);
            collector.add([{ index: 0, function: { arguments: '"A"}' } }]);
            collector.add([{ index: 2, function: { arguments: '{}' } }]);
            const calls = collector.toolCalls(3);
            expect(
                json(calls) ===
                    json([
                        { id: 'call_3_0', name: 'lookup_weather', argumentsJson: '{"city":"A"}' },
                        { id: 'call_3_1', name: 'lookup_weather', argumentsJson: '{"city":"B"}' },
                    ]),
                `calls come back in index order, nameless fragments dropped (got ${json(calls)})`
            );
        },
    },
    {
        name: 'client tools are offered to chat models, never to image models',
        body: async () => {
            const { result: platforms } = await captureConsole(async () => ({
                openai: new OpenAIPlatform(),
                anthropic: new AnthropicPlatform(),
                deepseek: new DeepSeekPlatform(),
                mimo: new MimoPlatform(),
            }));
            expect(platforms.openai.getModelCapabilities('gpt-6-luna').supportsClientTools === true, 'gpt-6-luna gets client tools');
            expect(
                platforms.openai.getModelCapabilities(OPENAI_IMAGE_MODEL).supportsClientTools === false,
                `${OPENAI_IMAGE_MODEL} does not`
            );
            expect(platforms.openai.getModelCapabilities('dall-e-3').supportsClientTools === false, 'dall-e-3 does not');
            expect(
                platforms.anthropic.getModelCapabilities('claude-sonnet-5').supportsClientTools === true,
                'claude gets client tools'
            );
            expect(
                platforms.deepseek.getModelCapabilities('deepseek-flash').supportsClientTools === true,
                'deepseek gets client tools'
            );
            expect(
                platforms.mimo.getModelCapabilities('mimo-v2.6-pro').supportsClientTools === true,
                'mimo gets client tools'
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
