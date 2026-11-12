/**
 * Offline cases for the usage collection of all six platforms (design
 * appendix B): every finished round reports once into the reply's usage
 * sink — the plain request and each tool loop round alike — a later round
 * that fails keeps the rounds before it, DeepSeek and MiMo ask for the usage
 * chunk, Gemini names its lane as the route and reports the tier each round
 * was served at (Priority PayGo).
 *
 * One local stub answers every OpenAI-compatible platform (each under its own
 * base path) with scripted SSE rounds; Gemini gets a Vertex client with a
 * fake fetch, like tools-gemini.mts. No network, no database.
 *
 * Run: npx tsx scripts/offline/usage-platforms.mts
 */
import { createServer } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler } from '../../src/ai/tools/index.js';

interface ScriptedReply {
    readonly path: string;
    readonly status: number;
    readonly body: string;
}

const scripted: ScriptedReply[] = [];
const recorded: Array<{ path: string; body: Record<string, unknown> }> = [];

const stub = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        const raw = Buffer.concat(parts).toString('utf8');
        recorded.push({ path, body: raw ? JSON.parse(raw) : {} });
        const next = scripted.shift();
        if (!next || next.path !== path || next.status !== 200) {
            response.writeHead(next?.status ?? 400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: `refused request to ${path}` } }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(next.body);
    });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const address = stub.address();
if (address === null || typeof address === 'string') throw new Error('the stub has no TCP address');
const base = `http://127.0.0.1:${address.port}`;

// Read by the platform constructors
process.env.OPENAI_API_URL = `${base}/openai/v1`;
process.env.OPENAI_API_KEY = 'offline-stub';
process.env.ANTHROPIC_API_URL = `${base}/anthropic`;
process.env.ANTHROPIC_API_KEY = 'offline-stub';
process.env.DEEPSEEK_API_URL = `${base}/deepseek/v1`;
process.env.DEEPSEEK_API_KEY = 'offline-stub';
process.env.MIMO_API_URL = `${base}/mimo/v1`;
process.env.MIMO_API_KEY = 'offline-stub';
process.env.GROK_API_URL = `${base}/grok/v1`;
process.env.GROK_API_KEY = 'offline-stub';
// Gemini client tools on, whatever the shell says
delete process.env.GEMINI_CLIENT_TOOLS;

const { OpenAIPlatform } = await import('../../src/ai/platforms/openai-platform.js');
const { AnthropicPlatform } = await import('../../src/ai/platforms/anthropic-platform.js');
const { DeepSeekPlatform } = await import('../../src/ai/platforms/deepseek-platform.js');
const { MimoPlatform } = await import('../../src/ai/platforms/mimo-platform.js');
const { GrokPlatform } = await import('../../src/ai/platforms/grok-platform.js');
const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');
const { createUsageSink, geminiServedTier } = await import('../../src/ai/usage/index.js');

type UsageSink = import('../../src/ai/usage/index.js').UsageSink;
type ReplyUsageTotals = import('../../src/ai/usage/index.js').ReplyUsageTotals;

const json = (value: unknown): string => JSON.stringify(value);

const weatherTool: ToolHandler = {
    definition: {
        name: 'lookup_weather',
        description: 'Look up the weather of a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    execute: async (args) => ({ content: `sunny in ${String(args.city)}`, isError: false, images: [], record: null }),
};
const turnTools = createTurnTools([weatherTool]);

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

const quietly = async <T,>(body: () => Promise<T>): Promise<T> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
        return await body();
    } finally {
        Object.assign(console, original);
    }
};

/** Drain a reply; a thrown error is returned, not raised */
const drain = async (open: () => Promise<AsyncIterable<StreamChunk>>): Promise<{ text: string; error: string | null }> =>
    quietly(async () => {
        let text = '';
        try {
            for await (const chunk of await open()) {
                if (chunk.type === 'text') text += chunk.content ?? '';
            }
            return { text, error: null };
        } catch (error) {
            return { text, error: error instanceof Error ? error.message : String(error) };
        }
    });

const reset = (...replies: ScriptedReply[]): void => {
    scripted.length = 0;
    scripted.push(...replies);
    recorded.length = 0;
};

const totalsOf = (sink: UsageSink): ReplyUsageTotals => sink.totals();

const expectTotals = (sink: UsageSink, expected: Partial<ReplyUsageTotals>, label: string): void => {
    const totals = totalsOf(sink);
    const mismatch = Object.entries(expected).filter(([key, value]) => Reflect.get(totals, key) !== value);
    expect(mismatch.length === 0, `${label} (got ${json(totals)})`);
};

// ---- SSE fixtures ----

const dataLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const namedEvent = (event: Record<string, unknown>): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const ok = (path: string, body: string): ScriptedReply => ({ path, status: 200, body });
const refused = (path: string): ScriptedReply => ({ path, status: 400, body: '' });

// chat.completions (DeepSeek, MiMo)
const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'offline',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});
const usageChunk = (usage: Record<string, unknown>) => ({ ...chatChunk({}), choices: [], usage });
const chatAnswer = (text: string, usage: Record<string, unknown>): string =>
    [chatChunk({ content: text }), chatChunk({}, 'stop'), usageChunk(usage)].map(dataLine).join('') + 'data: [DONE]\n\n';
const chatToolRound = (usage: Record<string, unknown>): string =>
    [
        chatChunk({
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Oslo"}' } }],
        }),
        chatChunk({}, 'tool_calls'),
        usageChunk(usage),
    ]
        .map(dataLine)
        .join('') + 'data: [DONE]\n\n';

// Responses API (OpenAI, Grok)
const responseObject = (id: string, output: readonly unknown[], usage: Record<string, unknown>) => ({
    id,
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'offline',
    output,
    error: null,
    incomplete_details: null,
    usage,
});
const functionCall = (callId: string) => ({
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name: 'lookup_weather',
    arguments: '{"city":"Paris"}',
    status: 'completed',
});
const responsesAnswer = (id: string, text: string, usage: Record<string, unknown>): string =>
    [
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
        { type: 'response.completed', response: responseObject(id, [], usage) },
    ]
        .map(namedEvent)
        .join('');
const responsesToolRound = (id: string, usage: Record<string, unknown>): string =>
    [
        { type: 'response.output_item.done', output_index: 0, item: functionCall(`call_${id}`) },
        { type: 'response.completed', response: responseObject(id, [functionCall(`call_${id}`)], usage) },
    ]
        .map(namedEvent)
        .join('');

// Anthropic Messages
const messageStart = (usage: Record<string, unknown>) => ({
    type: 'message_start',
    message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage },
});
const messagesAnswer = (text: string, startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>): string =>
    [
        messageStart(startUsage),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: deltaUsage },
        { type: 'message_stop' },
    ]
        .map(namedEvent)
        .join('');
const messagesToolRound = (startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>): string =>
    [
        messageStart(startUsage),
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup_weather', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Rome"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: deltaUsage },
        { type: 'message_stop' },
    ]
        .map(namedEvent)
        .join('');

// ---- Gemini: a Vertex client whose fetch replays scripted rounds ----

const geminiReplies: string[] = [];
let geminiRequests = 0;
/** The Priority PayGo header of each Gemini request, null when absent */
const geminiPriorityHeaders: Array<string | null> = [];
const geminiFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    geminiRequests += 1;
    geminiPriorityHeaders.push(new Headers(init?.headers).get('x-vertex-ai-llm-shared-request-type'));
    const body = geminiReplies.shift();
    if (body === undefined) {
        return new Response(json({ error: { code: 400, message: 'unexpected request', status: 'INVALID_ARGUMENT' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const geminiPlatform = new GeminiPlatform({
    client: new GoogleGenAI({
        vertexai: true,
        project: 'test',
        location: 'global',
        googleAuthOptions: { apiKey: 'offline', projectId: 'test' },
        httpOptions: { fetch: geminiFetch },
    }),
});
const geminiEvents = (parts: readonly unknown[], usageMetadata: Record<string, unknown>): string =>
    [
        { candidates: [{ content: { role: 'model', parts } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata },
    ]
        .map(dataLine)
        .join('');

// ---- cases ----

const DEEPSEEK_PATH = '/deepseek/v1/chat/completions';
const MIMO_PATH = '/mimo/v1/chat/completions';
const OPENAI_PATH = '/openai/v1/responses';
const GROK_PATH = '/grok/v1/responses';
const ANTHROPIC_PATH = '/anthropic/v1/messages';

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'DeepSeek: every request asks for the usage chunk; plain and tool rounds report once each',
        body: async () => {
            const deepseek = new DeepSeekPlatform();
            const plainSink = createUsageSink();
            reset(ok(DEEPSEEK_PATH, chatAnswer('晴', { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 9, total_tokens: 109 })));
            const plain = await drain(() =>
                deepseek.sendMessage(userTurn('天气'), { model: 'deepseek-flash', timeout: 20000, usageSink: plainSink })
            );
            expect(plain.error === null && plain.text === '晴', `the reply streams as before (got ${json(plain)})`);
            expect(
                json(recorded[0]?.body.stream_options) === json({ include_usage: true }),
                `stream_options.include_usage (got ${json(recorded[0]?.body.stream_options)})`
            );
            expectTotals(plainSink, { rounds: 1, promptTokens: 100, cachedTokens: 60, outputTokens: 9 }, 'the plain request: one round');

            const loopSink = createUsageSink();
            reset(
                ok(DEEPSEEK_PATH, chatToolRound({ prompt_tokens: 200, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200, completion_tokens: 20, total_tokens: 220 })),
                ok(DEEPSEEK_PATH, chatAnswer('奥斯陆晴', { prompt_tokens: 260, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 60, completion_tokens: 15, total_tokens: 275 }))
            );
            const loop = await drain(() =>
                deepseek.sendMessage(userTurn('奥斯陆天气'), { model: 'deepseek-flash', timeout: 20000, tools: turnTools, usageSink: loopSink })
            );
            expect(loop.error === null && loop.text === '奥斯陆晴', `the tool loop answers (got ${json(loop)})`);
            expect(recorded.length === 2 && recorded.every((request) => json(request.body.stream_options) === json({ include_usage: true })), 'both rounds ask for usage');
            expectTotals(loopSink, { rounds: 2, promptTokens: 460, cachedTokens: 200, outputTokens: 35 }, 'two rounds summed');

            const failedSink = createUsageSink();
            reset(
                ok(DEEPSEEK_PATH, chatToolRound({ prompt_tokens: 300, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 300, completion_tokens: 10 })),
                refused(DEEPSEEK_PATH)
            );
            const failed = await drain(() =>
                deepseek.sendMessage(userTurn('奥斯陆天气'), { model: 'deepseek-flash', timeout: 20000, maxRetries: 1, tools: turnTools, usageSink: failedSink })
            );
            expect(failed.error !== null, 'round 2 fails the reply');
            expectTotals(failedSink, { rounds: 1, promptTokens: 300, outputTokens: 10 }, 'round 1 stays counted');
        },
    },
    {
        name: 'MiMo: the usage chunk on the plain request and on each tool round',
        body: async () => {
            const mimo = new MimoPlatform();
            const plainSink = createUsageSink();
            reset(ok(MIMO_PATH, chatAnswer('好', { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 32 }, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 8 }, total_tokens: 62 })));
            const plain = await drain(() => mimo.sendMessage(userTurn('你好'), { model: 'mimo-v2.6-flash', timeout: 20000, usageSink: plainSink }));
            expect(plain.error === null && plain.text === '好', `the reply streams (got ${json(plain)})`);
            expect(json(recorded[0]?.body.stream_options) === json({ include_usage: true }), 'stream_options.include_usage');
            expectTotals(plainSink, { rounds: 1, promptTokens: 50, cachedTokens: 32, outputTokens: 12, thoughtsTokens: 8 }, 'one round');

            const loopSink = createUsageSink();
            reset(
                ok(MIMO_PATH, chatToolRound({ prompt_tokens: 70, completion_tokens: 5, total_tokens: 75 })),
                ok(MIMO_PATH, chatAnswer('奥斯陆晴', { prompt_tokens: 90, completion_tokens: 7, total_tokens: 97 }))
            );
            const loop = await drain(() =>
                mimo.sendMessage(userTurn('奥斯陆天气'), { model: 'mimo-v2.6-flash', timeout: 20000, tools: turnTools, usageSink: loopSink })
            );
            expect(loop.error === null && loop.text === '奥斯陆晴', `the tool loop answers (got ${json(loop)})`);
            expect(json(recorded[1]?.body.stream_options) === json({ include_usage: true }), 'tool rounds ask for usage too');
            expectTotals(loopSink, { rounds: 2, promptTokens: 160, outputTokens: 12 }, 'two rounds summed');
        },
    },
    {
        name: 'OpenAI Responses: the completed response carries each round usage',
        body: async () => {
            const openai = new OpenAIPlatform();
            const usage = { input_tokens: 400, input_tokens_details: { cached_tokens: 300 }, output_tokens: 90, output_tokens_details: { reasoning_tokens: 70 }, total_tokens: 490 };
            const plainSink = createUsageSink();
            reset(ok(OPENAI_PATH, responsesAnswer('resp_1', 'Hi', usage)));
            const plain = await drain(() => openai.sendMessage(userTurn('hi'), { model: 'gpt-6-luna', timeout: 20000, usageSink: plainSink }));
            expect(plain.error === null && plain.text === 'Hi', `the reply streams (got ${json(plain)})`);
            expectTotals(plainSink, { rounds: 1, promptTokens: 400, cachedTokens: 300, outputTokens: 90, thoughtsTokens: 70 }, 'one round');

            const loopSink = createUsageSink();
            reset(
                ok(OPENAI_PATH, responsesToolRound('resp_2', { input_tokens: 500, output_tokens: 20, total_tokens: 520 })),
                ok(OPENAI_PATH, responsesAnswer('resp_3', 'Sunny', { input_tokens: 560, output_tokens: 30, total_tokens: 590 }))
            );
            const loop = await drain(() =>
                openai.sendMessage(userTurn('weather?'), { model: 'gpt-6-luna', timeout: 20000, tools: turnTools, usageSink: loopSink })
            );
            expect(loop.error === null && loop.text === 'Sunny', `the tool loop answers (got ${json(loop)})`);
            expectTotals(loopSink, { rounds: 2, promptTokens: 1060, outputTokens: 50 }, 'two rounds summed');
        },
    },
    {
        name: 'Anthropic: message_start and message_delta usage, without and with tools',
        body: async () => {
            const anthropic = new AnthropicPlatform();
            const plainSink = createUsageSink();
            reset(ok(ANTHROPIC_PATH, messagesAnswer('Ciao', { input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, { output_tokens: 44 })));
            const plain = await drain(() => anthropic.sendMessage(userTurn('ciao'), { model: 'claude-sonnet-5', timeout: 20000, usageSink: plainSink }));
            expect(plain.error === null && plain.text === 'Ciao', `the reply streams (got ${json(plain)})`);
            expectTotals(plainSink, { rounds: 1, promptTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 44 }, 'one round');

            const loopSink = createUsageSink();
            reset(
                ok(ANTHROPIC_PATH, messagesToolRound({ input_tokens: 80, output_tokens: 1 }, { output_tokens: 25 })),
                ok(ANTHROPIC_PATH, messagesAnswer('Roma: sole', { input_tokens: 120, output_tokens: 1 }, { output_tokens: 18 }))
            );
            const loop = await drain(() =>
                anthropic.sendMessage(userTurn('meteo Roma'), { model: 'claude-sonnet-5', timeout: 20000, tools: turnTools, usageSink: loopSink })
            );
            expect(loop.error === null && loop.text === 'Roma: sole', `the tool loop answers (got ${json(loop)})`);
            expectTotals(loopSink, { rounds: 2, promptTokens: 200, outputTokens: 43 }, 'two rounds summed');
        },
    },
    {
        name: 'Grok: every closing response, the continuation included; reasoning outside output is added back',
        body: async () => {
            const grok = new GrokPlatform();
            const sink = createUsageSink();
            reset(
                ok(GROK_PATH, responsesToolRound('resp_g1', { input_tokens: 300, input_tokens_details: { cached_tokens: 100 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 350 })),
                ok(GROK_PATH, responsesAnswer('resp_g2', 'Paris is sunny.', { input_tokens: 50, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 58 }))
            );
            const reply = await drain(() =>
                grok.sendMessage(userTurn('Paris weather?'), { model: 'grok-4.7', timeout: 20000, tools: turnTools, usageSink: sink })
            );
            expect(reply.error === null && reply.text === 'Paris is sunny.', `the reply continues on the chain (got ${json(reply)})`);
            expect(recorded[1]?.body.previous_response_id === 'resp_g1', 'round 2 continues the response chain');
            expectTotals(
                sink,
                { rounds: 2, promptTokens: 350, cachedTokens: 100, outputTokens: 58, thoughtsTokens: 40 },
                'two rounds; round 1 output = 10 + 40 reasoning (its total says reasoning was outside)'
            );
        },
    },
    {
        name: 'Gemini: the single request, every tool loop round, and the lane as the route',
        body: async () => {
            const plainSink = createUsageSink();
            geminiReplies.length = 0;
            geminiReplies.push(geminiEvents([{ text: '好的' }], { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 130 }));
            const plain = await drain(() =>
                geminiPlatform.sendMessage(userTurn('你好'), { model: 'gemini-3.8-flash', systemPrompt: 'p', maxRetries: 1, usageSink: plainSink })
            );
            expect(plain.error === null && plain.text === '好的', `the single request streams (got ${json(plain)})`);
            expectTotals(
                plainSink,
                { rounds: 1, promptTokens: 120, cachedTokens: 100, outputTokens: 10, thoughtsTokens: 6, route: null },
                'one round, output = candidates + thoughts, the default lane has no route'
            );

            const loopSink = createUsageSink();
            geminiReplies.push(
                geminiEvents(
                    [{ functionCall: { name: 'lookup_weather', args: { city: 'Lyon' } }, thoughtSignature: Buffer.from('sig').toString('base64') }],
                    { promptTokenCount: 200, candidatesTokenCount: 12, totalTokenCount: 212 }
                ),
                geminiEvents([{ text: '里昂晴' }], { promptTokenCount: 260, cachedContentTokenCount: 200, candidatesTokenCount: 5, totalTokenCount: 265 })
            );
            const loop = await drain(() =>
                geminiPlatform.sendMessage(userTurn('里昂天气'), {
                    model: 'gemini-3.8-flash',
                    systemPrompt: 'p',
                    maxRetries: 1,
                    tools: turnTools,
                    usageSink: loopSink,
                })
            );
            expect(loop.error === null && loop.text === '里昂晴', `the tool loop answers (got ${json(loop)})`);
            expectTotals(loopSink, { rounds: 2, promptTokens: 460, cachedTokens: 200, outputTokens: 17 }, 'two rounds summed');

            const largeSink = createUsageSink();
            const requestsBefore = geminiRequests;
            geminiReplies.push(geminiEvents([{ text: '看完了' }], { promptTokenCount: 9000, candidatesTokenCount: 3, totalTokenCount: 9003 }));
            const large = await drain(() =>
                geminiPlatform.sendMessage(
                    [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: '看这个视频' },
                                { type: 'media', fileUri: 'gs://offline-bucket/clip.mp4', mimeType: 'video/mp4', sizeBytes: 30_000_000 },
                            ],
                        },
                    ],
                    { model: 'gemini-3.8-flash', systemPrompt: 'p', tools: turnTools, usageSink: largeSink }
                )
            );
            expect(large.error === null && geminiRequests === requestsBefore + 1, `gs:// media is one request (got ${json(large)})`);
            expectTotals(largeSink, { rounds: 1, promptTokens: 9000, route: 'large-media' }, 'its lane is the route');
        },
    },
    {
        name: 'Gemini: the tier each round was served at; round 1 standard and round 2 priority add up apart',
        body: async () => {
            expect(geminiServedTier({ trafficType: 'ON_DEMAND_PRIORITY' }) === 'priority', 'ON_DEMAND_PRIORITY is priority');
            expect(geminiServedTier({ trafficType: 'ON_DEMAND' }) === 'standard', 'ON_DEMAND is standard');
            expect(
                geminiServedTier({ promptTokenCount: 3 }) === undefined &&
                    geminiServedTier({ trafficType: 'ON_DEMAND_FLEX' }) === undefined &&
                    geminiServedTier(undefined) === undefined,
                'no trafficType, another tier or no usage: not said'
            );

            const sink = createUsageSink();
            geminiReplies.length = 0;
            geminiPriorityHeaders.length = 0;
            geminiReplies.push(
                geminiEvents(
                    [{ functionCall: { name: 'lookup_weather', args: { city: 'Lyon' } }, thoughtSignature: Buffer.from('sig').toString('base64') }],
                    { promptTokenCount: 200, cachedContentTokenCount: 50, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 220, trafficType: 'ON_DEMAND' }
                ),
                geminiEvents([{ text: '里昂晴' }], {
                    promptTokenCount: 260,
                    cachedContentTokenCount: 200,
                    candidatesTokenCount: 5,
                    thoughtsTokenCount: 4,
                    totalTokenCount: 269,
                    trafficType: 'ON_DEMAND_PRIORITY',
                })
            );
            const reply = await drain(() =>
                geminiPlatform.sendMessage(userTurn('里昂天气'), {
                    model: 'gemini-4-carbon',
                    systemPrompt: 'p',
                    maxRetries: 1,
                    tools: turnTools,
                    usageSink: sink,
                    serviceTier: 'priority',
                })
            );
            expect(reply.error === null && reply.text === '里昂晴', `the tool loop answers (got ${json(reply)})`);
            expect(json(geminiPriorityHeaders) === json(['priority', 'priority']), `both rounds asked (got ${json(geminiPriorityHeaders)})`);
            const totals = sink.totals();
            expectTotals(
                sink,
                { rounds: 2, promptTokens: 460, cachedTokens: 250, outputTokens: 29, tierRequested: 'priority', roundRetries: 0 },
                'both rounds in the totals, the request tier recorded'
            );
            expect(
                json(totals.priority) === json({ rounds: 1, promptTokens: 260, cachedTokens: 200, outputTokens: 9 }),
                `only round 2 was served at priority (got ${json(totals.priority)})`
            );

            const singleSink = createUsageSink();
            geminiReplies.push(
                geminiEvents([{ text: '好' }], { promptTokenCount: 30, candidatesTokenCount: 2, totalTokenCount: 32, trafficType: 'ON_DEMAND_PRIORITY' })
            );
            const single = await drain(() =>
                geminiPlatform.sendMessage(userTurn('你好'), { model: 'gemini-3.8-flash', systemPrompt: 'p', maxRetries: 1, usageSink: singleSink })
            );
            expect(single.error === null, 'the single request streams');
            expect(
                json(singleSink.totals().priority) === json({ rounds: 1, promptTokens: 30, cachedTokens: 0, outputTokens: 2 }) &&
                    singleSink.totals().tierRequested === null,
                `the single request reports its tier too; served at priority without asking stays visible (got ${json(singleSink.totals())})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
stub.close();
reportResults(results);
