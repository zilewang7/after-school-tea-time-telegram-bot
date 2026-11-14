/**
 * Offline cases for the thinking-effort wire of every platform (design
 * 2026-1113-1742 §3.3 / appendix D): the request bodies of
 * `PlatformConfig.thinkingEffort` in its three modes, the legacy body when the
 * field is absent, the one-shot downgrade after a level 400, and the rule that
 * 401/429 never count as a thinking rejection.
 *
 * The Anthropic wire beyond the effort lives here too: the headers SDK 1.x
 * sends to the relay, max_tokens from the model catalog with its own one-shot
 * downgrade (composed with the effort one), named SSE events the consumer does
 * not know, and the request rules of API version 2026-10-21.
 *
 * One local stub answers every OpenAI-compatible platform (each under its own
 * base path) with scripted rounds. Gemini has its own file
 * (gemini-thinking-level.mts). No network, no database.
 *
 * Run: npx tsx scripts/offline/platform-thinking-wire.mts
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler } from '../../src/ai/tools/index.js';

type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;

interface ScriptedReply {
    readonly path: string;
    readonly status: number;
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
}

const scripted: ScriptedReply[] = [];
const recorded: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];

const stub = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        const raw = Buffer.concat(parts).toString('utf8');
        recorded.push({ path, headers: request.headers, body: raw ? JSON.parse(raw) : {} });
        const next = scripted.shift();
        if (!next || next.path !== path) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: `unexpected request to ${path}` } }));
            return;
        }
        response.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers });
        response.end(next.body);
    });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubAddress = stub.address();
if (stubAddress === null || typeof stubAddress === 'string') throw new Error('the stub has no TCP address');
const base = `http://127.0.0.1:${stubAddress.port}`;

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

const { OpenAIPlatform } = await import('../../src/ai/platforms/openai-platform.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');
const { AnthropicPlatform } = await import('../../src/ai/platforms/anthropic-platform.js');
const { DeepSeekPlatform } = await import('../../src/ai/platforms/deepseek-platform.js');
const { MimoPlatform } = await import('../../src/ai/platforms/mimo-platform.js');
const { GrokPlatform } = await import('../../src/ai/platforms/grok-platform.js');
const { setModelCatalog } = await import('../../src/config/model-catalog.js');
const { emptyModelCapabilities } = await import('../../src/config/model-capabilities.js');

const json = (value: unknown): string => JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

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

/** Drain a stream; a thrown error is returned, not raised */
const drain = async (open: () => Promise<AsyncIterable<StreamChunk>>): Promise<{ text: string; error: string | null }> => {
    let text = '';
    try {
        for await (const chunk of await open()) {
            if (chunk.type === 'text') text += chunk.content ?? '';
        }
        return { text, error: null };
    } catch (error) {
        return { text, error: error instanceof Error ? error.message : String(error) };
    }
};

/** drain with the platform's console output captured */
const drainQuietly = (open: () => Promise<AsyncIterable<StreamChunk>>) =>
    captureConsole(() => drain(open)).then(({ result }) => result);

const reset = (...replies: ScriptedReply[]): void => {
    scripted.length = 0;
    scripted.push(...replies);
    recorded.length = 0;
};

const reply = (path: string, status: number, body: string): ScriptedReply => ({ path, status, body });

// ---- SSE fixtures ----

const dataLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const namedEvent = (event: Record<string, unknown>): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

/** chat.completions (DeepSeek, MiMo) */
const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'offline',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});
const chatBody = (chunks: readonly unknown[]): string => chunks.map(dataLine).join('') + 'data: [DONE]\n\n';

/** Responses API (OpenAI, Grok) */
const responseObject = (output: readonly unknown[]) => ({
    id: 'resp_offline',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'offline',
    output,
    error: null,
});
const responsesAnswer = (text: string): string =>
    [
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
        { type: 'response.completed', response: responseObject([]) },
    ]
        .map(namedEvent)
        .join('');

/** Anthropic Messages */
const messageStart = {
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
const messagesAnswer = (text: string): string =>
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

/** An SDK-shaped error body the platform receives as an HTTP 400 */
const errorBody = (message: string): string => JSON.stringify({ error: { message, type: 'invalid_request_error' } });

const ANTHROPIC_PATH = '/anthropic/v1/messages';

/** What a provider with a lower output ceiling answers to max_tokens 128000 */
const OVER_LIMIT = 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-5-5';
const EFFORT_REJECTED = 'output_config.effort: xhigh is not supported by this model';

/** A Messages round that calls lookup_weather once and stops for tool_use */
const messagesToolRound = (city: string): string =>
    [
        messageStart,
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: `toolu_${city}`, name: 'lookup_weather', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json({ city }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
    ]
        .map(namedEvent)
        .join('');

/** A catalog row that only says how many output tokens the model has */
const catalogRowWith = (id: string, outputTokens: number | null): ModelCatalogEntry => ({
    id,
    label: id,
    platform: 'anthropic',
    enabled: true,
    capabilities: { ...emptyModelCapabilities(), schema: 1, outputTokens },
    source: 'manual',
    checkedOn: '2026-11-14',
    confidence: 'high',
});

// ---- request body helpers ----

const bodyOf = (index: number): Record<string, unknown> => recorded[index]?.body ?? {};

const reasoningOf = (index: number): Record<string, unknown> | undefined => {
    const reasoning = bodyOf(index).reasoning;
    return reasoning === undefined ? undefined : asRecord(reasoning);
};

const thinkingOf = (index: number): Record<string, unknown> | undefined => {
    const thinking = bodyOf(index).thinking;
    return thinking === undefined ? undefined : asRecord(thinking);
};

const effortOf = (index: number): unknown => reasoningOf(index)?.effort;

const maxTokensAt = (index: number): unknown => bodyOf(index).max_tokens;

const outputConfigAt = (index: number): unknown => bodyOf(index).output_config;

const countLinesWith = (lines: readonly string[], text: string): number =>
    lines.filter((line) => line.includes(text)).length;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The content blocks of a message; a string content has none */
const blocksOf = (message: Record<string, unknown>): Record<string, unknown>[] => asArray(message.content).map(asRecord);

/** Every block of a message, the ones nested in a tool_result included */
const allBlocksOf = (message: Record<string, unknown>): Record<string, unknown>[] =>
    blocksOf(message).flatMap((block) => [block, ...asArray(block.content).map(asRecord)]);

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'openai without the field keeps the legacy xhigh',
        body: async () => {
            reset(reply('/openai/v1/responses', 200, responsesAnswer('legacy answer')));
            const platform = new OpenAIPlatform();
            const { text } = await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), { model: 'gpt-6-luna', timeout: 20000 })
            );
            expect(text === 'legacy answer', `the answer streams (got ${json(text)})`);
            expect(
                json(recorded[0]?.body.reasoning) === json({ effort: 'xhigh', summary: 'detailed' }),
                `legacy xhigh goes out (got ${json(recorded[0]?.body.reasoning)})`
            );
        },
    },
    {
        name: 'openai default sends the summary alone, explicit the effort, off nothing',
        body: async () => {
            const platform = new OpenAIPlatform();
            reset(reply('/openai/v1/responses', 200, responsesAnswer('default answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'gpt-6-luna',
                    timeout: 20000,
                    thinkingEffort: { mode: 'default', value: null },
                })
            );
            expect(
                json(recorded[0]?.body.reasoning) === json({ summary: 'detailed' }),
                `default keeps the summary without an effort (got ${json(recorded[0]?.body.reasoning)})`
            );

            reset(reply('/openai/v1/responses', 200, responsesAnswer('explicit answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'gpt-6-luna',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'low' },
                })
            );
            expect(
                json(recorded[0]?.body.reasoning) === json({ effort: 'low', summary: 'detailed' }),
                `explicit sends its effort (got ${json(recorded[0]?.body.reasoning)})`
            );

            reset(reply('/openai/v1/responses', 200, responsesAnswer('off answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'gpt-6-luna',
                    timeout: 20000,
                    thinkingEffort: { mode: 'off', value: null },
                })
            );
            expect(!('reasoning' in bodyOf(0)), `off drops the reasoning object (got ${json(bodyOf(0))})`);

            reset(reply('/openai/v1/responses', 200, responsesAnswer('plain answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'gpt-4.1',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'high' },
                })
            );
            expect(
                !('reasoning' in bodyOf(0)),
                `a non-reasoning model never gets reasoning (got ${json(bodyOf(0))})`
            );
        },
    },
    {
        name: 'openai downgrades a rejected explicit effort once and warns',
        body: async () => {
            reset(
                reply('/openai/v1/responses', 400, errorBody('Unsupported value: reasoning.effort xhigh')),
                reply('/openai/v1/responses', 200, responsesAnswer('downgraded answer'))
            );
            const platform = new OpenAIPlatform();
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'gpt-6-luna',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                    })
                )
            );
            expect(result.text === 'downgraded answer', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry (got ${recorded.length})`);
            expect(effortOf(0) === 'xhigh', `the first attempt sends xhigh (got ${json(effortOf(0))})`);
            expect(effortOf(1) === 'high', `the retry sends the next lower effort (got ${json(effortOf(1))})`);
            expect(
                lines.some((line) => line.includes('rejected thinking effort xhigh; retrying with high')),
                `the downgrade is logged (got ${json(lines)})`
            );
        },
    },
    {
        name: 'openai does not downgrade on 401, 404 or 429',
        body: async () => {
            const platform = new OpenAIPlatform();
            for (const status of [401, 404, 429]) {
                reset(reply('/openai/v1/responses', status, errorBody('reasoning effort auth/quota problem')));
                // The SDK retries 429 on its own too; none of those retries may
                // change the effort, and the downgrade warn must never appear.
                const { result, lines } = await captureConsole(async () =>
                    drain(() =>
                        platform.sendMessage(userTurn('hi'), {
                            model: 'gpt-6-luna',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        })
                    )
                );
                expect(result.error !== null, `${status}: the reply fails`);
                expect(recorded.length >= 1, `${status}: at least one request (got ${recorded.length})`);
                expect(
                    recorded.every((entry) => asRecord(entry.body.reasoning).effort === 'xhigh'),
                    `${status}: every body keeps xhigh (got ${json(recorded.map((entry) => entry.body.reasoning))})`
                );
                expect(
                    !lines.some((line) => line.includes('rejected thinking effort')),
                    `${status}: no downgrade was logged (got ${json(lines)})`
                );
            }
        },
    },
    {
        name: 'anthropic keeps adaptive thinking and adds output_config only for explicit',
        body: async () => {
            const platform = new AnthropicPlatform();
            reset(reply('/anthropic/v1/messages', 200, messagesAnswer('legacy answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), { model: 'claude-sonnet-5-5', timeout: 20000 })
            );
            expect(
                json(bodyOf(0).thinking) === json({ type: 'adaptive', display: 'summarized' }),
                `legacy keeps adaptive (got ${json(bodyOf(0).thinking)})`
            );
            expect(!('output_config' in bodyOf(0)), 'legacy sends no output_config');

            reset(reply('/anthropic/v1/messages', 200, messagesAnswer('default answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'claude-sonnet-5-5',
                    timeout: 20000,
                    thinkingEffort: { mode: 'default', value: null },
                })
            );
            expect(!('output_config' in bodyOf(0)), 'default sends no output_config');

            reset(reply('/anthropic/v1/messages', 200, messagesAnswer('explicit answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'claude-sonnet-5-5',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'high' },
                })
            );
            expect(
                json(bodyOf(0).output_config) === json({ effort: 'high' }),
                `explicit sends output_config.effort (got ${json(bodyOf(0).output_config)})`
            );
        },
    },
    {
        name: 'anthropic retries without output_config when the effort is rejected',
        body: async () => {
            reset(
                reply('/anthropic/v1/messages', 400, errorBody('output_config: Extra inputs are not permitted')),
                reply('/anthropic/v1/messages', 200, messagesAnswer('downgraded answer'))
            );
            const platform = new AnthropicPlatform();
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                    })
                )
            );
            expect(result.text === 'downgraded answer', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry (got ${recorded.length})`);
            expect(json(bodyOf(0).output_config) === json({ effort: 'xhigh' }), 'the first attempt sends the effort');
            expect(!('output_config' in bodyOf(1)), `the retry drops output_config (got ${json(bodyOf(1))})`);
            expect(
                lines.some((line) => line.includes('rejected thinking effort xhigh; retrying with adaptive thinking')),
                `the downgrade is logged (got ${json(lines)})`
            );
        },
    },
    {
        name: 'anthropic does not downgrade on 401, 404 or 429',
        body: async () => {
            const platform = new AnthropicPlatform();
            for (const status of [401, 404, 429]) {
                reset(reply('/anthropic/v1/messages', status, errorBody('output_config effort permission problem')));
                const { result, lines } = await captureConsole(async () =>
                    drain(() =>
                        platform.sendMessage(userTurn('hi'), {
                            model: 'claude-sonnet-5-5',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        })
                    )
                );
                expect(result.error !== null, `${status}: the reply fails`);
                expect(recorded.length >= 1, `${status}: at least one request (got ${recorded.length})`);
                expect(
                    recorded.every((entry) => json(entry.body.output_config) === json({ effort: 'xhigh' })),
                    `${status}: every body keeps the effort (got ${json(recorded.map((entry) => entry.body.output_config))})`
                );
                expect(
                    !lines.some((line) => line.includes('rejected thinking effort')),
                    `${status}: no downgrade was logged (got ${json(lines)})`
                );
            }
        },
    },
    {
        name: 'anthropic sends the key as Bearer and API version 2026-10-21, no x-api-key',
        body: async () => {
            // SDK 1.x moved the key from x-api-key to Authorization: Bearer and
            // the version from 2023-06-01 to 2026-10-21. Production talks to a
            // relay, not to Anthropic: a later SDK that changes what goes to
            // the relay should fail this case, not production.
            reset(reply(ANTHROPIC_PATH, 200, messagesAnswer('header answer')));
            const { text } = await drainQuietly(() =>
                new AnthropicPlatform().sendMessage(userTurn('hi'), { model: 'claude-sonnet-5-5', timeout: 20000 })
            );
            expect(text === 'header answer', `the answer streams (got ${json(text)})`);
            const headers = recorded[0]?.headers ?? {};
            expect(headers.authorization === 'Bearer offline-stub', `the key rides Authorization (got ${json(headers.authorization)})`);
            expect(
                headers['anthropic-version'] === '2026-10-21',
                `the API version is 2026-10-21 (got ${json(headers['anthropic-version'])})`
            );
            expect(!('x-api-key' in headers), `no x-api-key header (got ${json(Object.keys(headers))})`);
        },
    },
    {
        name: 'anthropic asks for the catalog output limit as max_tokens, 64000 for an unknown claude id',
        body: async () => {
            const platform = new AnthropicPlatform();
            try {
                setModelCatalog([]);
                reset(reply(ANTHROPIC_PATH, 200, messagesAnswer('seed answer')));
                await drainQuietly(() =>
                    platform.sendMessage(userTurn('hi'), { model: 'claude-sonnet-5-5', timeout: 20000 })
                );
                expect(maxTokensAt(0) === 128_000, `the seed's 128000 goes out (got ${json(maxTokensAt(0))})`);

                setModelCatalog([catalogRowWith('claude-opus-5-5', 100_000)], 'offline');
                reset(reply(ANTHROPIC_PATH, 200, messagesAnswer('catalog answer')));
                await drainQuietly(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'claude-opus-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'max' },
                    })
                );
                expect(maxTokensAt(0) === 100_000, `a catalog row wins over the seed (got ${json(maxTokensAt(0))})`);

                reset(reply(ANTHROPIC_PATH, 200, messagesAnswer('unknown answer')));
                await drainQuietly(() =>
                    platform.sendMessage(userTurn('hi'), { model: 'claude-offline-unknown', timeout: 20000 })
                );
                expect(maxTokensAt(0) === 64_000, `an unknown id gets 64000 (got ${json(maxTokensAt(0))})`);
            } finally {
                setModelCatalog([]);
            }
        },
    },
    {
        name: 'anthropic drops max_tokens to 16000 once and keeps it for the later tool rounds',
        body: async () => {
            reset(
                reply(ANTHROPIC_PATH, 400, errorBody(OVER_LIMIT)),
                reply(ANTHROPIC_PATH, 200, messagesToolRound('Paris')),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('Paris is sunny.'))
            );
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(userTurn('Weather in Paris?'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.error === null && result.text.endsWith('Paris is sunny.'), `the reply completes (got ${json(result)})`);
            expect(recorded.length === 3, `rejected round, its retry, the next round (got ${recorded.length})`);
            expect(
                json(recorded.map((_entry, index) => maxTokensAt(index))) === json([128_000, 16_000, 16_000]),
                `128000, then 16000 for the retry and the later round (got ${json(recorded.map((entry) => entry.body.max_tokens))})`
            );
            expect(
                countLinesWith(lines, 'claude-sonnet-5-5 rejected max_tokens 128000; retrying with 16000: ') === 1 &&
                    countLinesWith(lines, 'maximum allowed number of output tokens') === 1,
                `one warn line with the model and the error text (got ${json(lines)})`
            );
            expect(countLinesWith(lines, 'rejected thinking effort') === 0, 'no effort downgrade was involved');
        },
    },
    {
        name: 'anthropic does not lower max_tokens a second time in the same reply',
        body: async () => {
            reset(
                reply(ANTHROPIC_PATH, 400, errorBody(OVER_LIMIT)),
                reply(ANTHROPIC_PATH, 200, messagesToolRound('Oslo')),
                reply(ANTHROPIC_PATH, 400, errorBody(OVER_LIMIT)),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('never sent'))
            );
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(userTurn('Weather in Oslo?'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.error !== null, `the second rejection fails the reply (got ${json(result)})`);
            expect(recorded.length === 3, `no retry after the second rejection (got ${recorded.length})`);
            expect(countLinesWith(lines, 'rejected max_tokens') === 1, `logged once (got ${json(lines)})`);
        },
    },
    {
        name: 'anthropic does not retry a 400 about something else',
        body: async () => {
            reset(
                reply(ANTHROPIC_PATH, 400, errorBody('messages.1.content: text content blocks must be non-empty')),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('never sent'))
            );
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(userTurn('hi'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                    })
                )
            );
            expect(result.error !== null, 'the reply fails');
            expect(recorded.length === 1, `a single request (got ${recorded.length})`);
            expect(
                countLinesWith(lines, 'rejected max_tokens') === 0 && countLinesWith(lines, 'rejected thinking effort') === 0,
                `nothing was downgraded (got ${json(lines)})`
            );
        },
    },
    {
        name: 'anthropic does not lower max_tokens on 401, 403, 404, 429 or 5xx',
        body: async () => {
            const platform = new AnthropicPlatform();
            for (const status of [401, 403, 404, 429, 500, 503]) {
                // Every SDK retry of 429/5xx gets the same answer, without the backoff wait
                const failure: ScriptedReply = {
                    ...reply(ANTHROPIC_PATH, status, errorBody(OVER_LIMIT)),
                    headers: { 'retry-after-ms': '1' },
                };
                reset(failure, failure, failure);
                const { result, lines } = await captureConsole(async () =>
                    drain(() =>
                        platform.sendMessage(userTurn('hi'), {
                            model: 'claude-sonnet-5-5',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        })
                    )
                );
                expect(result.error !== null, `${status}: the reply fails`);
                expect(recorded.length >= 1, `${status}: at least one request (got ${recorded.length})`);
                expect(
                    recorded.every((entry) => entry.body.max_tokens === 128_000),
                    `${status}: every body keeps 128000 (got ${json(recorded.map((entry) => entry.body.max_tokens))})`
                );
                expect(countLinesWith(lines, 'rejected max_tokens') === 0, `${status}: no downgrade was logged (got ${json(lines)})`);
            }
        },
    },
    {
        name: 'anthropic drops the effort, then max_tokens, and later rounds keep both',
        body: async () => {
            reset(
                reply(ANTHROPIC_PATH, 400, errorBody(EFFORT_REJECTED)),
                reply(ANTHROPIC_PATH, 400, errorBody(OVER_LIMIT)),
                reply(ANTHROPIC_PATH, 200, messagesToolRound('Lima')),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('Lima is sunny.'))
            );
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(userTurn('Weather in Lima?'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.error === null && result.text.endsWith('Lima is sunny.'), `the reply completes (got ${json(result)})`);
            expect(recorded.length === 4, `two rejections, the tool round, the answer (got ${recorded.length})`);
            expect(
                json(recorded.map((_entry, index) => maxTokensAt(index))) === json([128_000, 128_000, 16_000, 16_000]),
                `max_tokens per request (got ${json(recorded.map((entry) => entry.body.max_tokens))})`
            );
            expect(
                json(recorded.map((_entry, index) => outputConfigAt(index) ?? null)) ===
                    json([{ effort: 'xhigh' }, null, null, null]),
                `output_config per request (got ${json(recorded.map((entry) => entry.body.output_config))})`
            );
            expect(
                countLinesWith(lines, 'rejected thinking effort xhigh') === 1 && countLinesWith(lines, 'rejected max_tokens') === 1,
                `each downgrade is logged once (got ${json(lines)})`
            );
        },
    },
    {
        name: 'anthropic drops max_tokens, then the effort, and neither happens twice',
        body: async () => {
            reset(
                reply(ANTHROPIC_PATH, 400, errorBody(OVER_LIMIT)),
                reply(ANTHROPIC_PATH, 400, errorBody(EFFORT_REJECTED)),
                reply(ANTHROPIC_PATH, 200, messagesToolRound('Rome')),
                // Names both parameters: with both downgrades spent it is final
                reply(ANTHROPIC_PATH, 400, errorBody('output_config.effort xhigh needs max_tokens above 16000')),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('never sent'))
            );
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(userTurn('Weather in Rome?'), {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.error !== null, `the third rejection fails the reply (got ${json(result)})`);
            expect(recorded.length === 4, `no retry after the third rejection (got ${recorded.length})`);
            expect(
                json(recorded.map((_entry, index) => maxTokensAt(index))) === json([128_000, 16_000, 16_000, 16_000]),
                `max_tokens per request (got ${json(recorded.map((entry) => entry.body.max_tokens))})`
            );
            expect(
                json(recorded.map((_entry, index) => outputConfigAt(index) ?? null)) ===
                    json([{ effort: 'xhigh' }, { effort: 'xhigh' }, null, null]),
                `output_config per request (got ${json(recorded.map((entry) => entry.body.output_config))})`
            );
            expect(
                countLinesWith(lines, 'rejected thinking effort xhigh') === 1 && countLinesWith(lines, 'rejected max_tokens') === 1,
                `each downgrade is logged once (got ${json(lines)})`
            );
        },
    },
    {
        name: 'anthropic ignores named SSE events it does not know and completes the reply',
        body: async () => {
            // SDK 1.x hands every named event to the caller (0.122 dropped the
            // names it did not know), so a relay's own events now reach the
            // round consumer, with any JSON body.
            const unknownEvents =
                `event: relay_heartbeat\ndata: ${json({ type: 'relay_heartbeat', queue: 0 })}\n\n` +
                `event: relay_status\ndata: ${json({ status: 'ok' })}\n\n` +
                'event: relay_tick\ndata: 42\n\n';
            const events = (list: readonly Record<string, unknown>[]): string => list.map(namedEvent).join('');
            const body =
                events([messageStart]) +
                unknownEvents +
                events([
                    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'all ' } },
                ]) +
                unknownEvents +
                events([
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'good' } },
                    { type: 'content_block_stop', index: 0 },
                    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
                ]) +
                unknownEvents +
                events([{ type: 'message_stop' }]);
            reset(reply(ANTHROPIC_PATH, 200, body));
            const { text, error } = await drainQuietly(() =>
                new AnthropicPlatform().sendMessage(userTurn('hi'), { model: 'claude-sonnet-5-5', timeout: 20000 })
            );
            expect(error === null, `the reply does not fail (got ${json(error)})`);
            expect(text === 'all good', `the known events still build the answer (got ${json(text)})`);
            expect(recorded.length === 1, `one request, no retry (got ${recorded.length})`);
        },
    },
    {
        name: 'anthropic tool-loop bodies carry no sampling keys, no documents and no citations',
        body: async () => {
            // API version 2026-10-21 answers 400 to temperature/top_p/top_k, to a
            // document block in an assistant turn and to citations in a user
            // text block. History with images, a PDF and an assistant image,
            // and a replayed round with every block kind, must avoid all three.
            const pixel = 'iVBORw0KGgo=';
            const history: UnifiedMessage[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Earlier question' },
                        { type: 'image', imageData: pixel, mimeType: 'image/png' },
                        { type: 'media', mediaData: pixel, mimeType: 'application/pdf' },
                    ],
                },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Earlier answer' },
                        { type: 'image', imageData: pixel, mimeType: 'image/png' },
                    ],
                },
                { role: 'user', content: [{ type: 'text', text: 'Weather in Rome?' }] },
            ];
            const toolRound: Record<string, unknown>[] = [
                messageStart,
                { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weather first.' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-offline' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-blob' } },
                { type: 'content_block_stop', index: 1 },
                // A provider may attach citations to its text; a replay never carries them
                { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: [] } },
                { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Checking.' } },
                { type: 'content_block_stop', index: 2 },
                {
                    type: 'content_block_start',
                    index: 3,
                    content_block: { type: 'tool_use', id: 'toolu_rome', name: 'lookup_weather', input: {} },
                },
                { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"city":"Rome"}' } },
                { type: 'content_block_stop', index: 3 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
                { type: 'message_stop' },
            ];
            reset(
                reply(ANTHROPIC_PATH, 200, toolRound.map(namedEvent).join('')),
                reply(ANTHROPIC_PATH, 200, messagesAnswer('Rome is sunny.'))
            );
            const { result } = await captureConsole(async () =>
                drain(() =>
                    new AnthropicPlatform().sendMessage(history, {
                        model: 'claude-sonnet-5-5',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'high' },
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.error === null && recorded.length === 2, `one tool round and the answer (got ${json(result)})`);

            const replayedKinds = new Set(['thinking', 'redacted_thinking', 'text', 'tool_use']);
            for (const [index, entry] of recorded.entries()) {
                const sampling = ['temperature', 'top_p', 'top_k'].filter((key) => key in entry.body);
                expect(sampling.length === 0, `request ${index}: no sampling keys (got ${json(sampling)})`);
                const messages = asArray(entry.body.messages).map(asRecord);
                for (const message of messages.filter((candidate) => candidate.role === 'assistant')) {
                    const kinds = blocksOf(message).map((block) => block.type);
                    expect(
                        typeof message.content === 'string' || kinds.every((kind) => typeof kind === 'string' && replayedKinds.has(kind)),
                        `request ${index}: an assistant turn holds only replayed block kinds (got ${json(message.content)})`
                    );
                }
                const blocks = messages.flatMap(allBlocksOf);
                expect(
                    blocks.every((block) => block.type !== 'document'),
                    `request ${index}: no document block anywhere (got ${json(blocks.map((block) => block.type))})`
                );
                expect(
                    blocks.every((block) => !('citations' in block)),
                    `request ${index}: no block carries citations (got ${json(blocks.filter((block) => 'citations' in block))})`
                );
            }
            const replayed = asArray(bodyOf(1).messages).map(asRecord).at(-2) ?? {};
            expect(
                replayed.role === 'assistant' &&
                    json(blocksOf(replayed).map((block) => block.type)) ===
                        json(['thinking', 'redacted_thinking', 'text', 'tool_use']),
                `the tool round is replayed block for block (got ${json(replayed)})`
            );
        },
    },
    {
        name: 'deepseek legacy and default send no thinking params, explicit sends both',
        body: async () => {
            const platform = new DeepSeekPlatform();
            reset(reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'legacy' }), chatChunk({}, 'stop')])));
            await drainQuietly(() => platform.sendMessage(userTurn('hi'), { model: 'deepseek-flash', timeout: 20000 }));
            expect(!('thinking' in bodyOf(0)) && !('reasoning_effort' in bodyOf(0)), `legacy body unchanged (got ${json(bodyOf(0))})`);

            reset(reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'default' }), chatChunk({}, 'stop')])));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'deepseek-flash',
                    timeout: 20000,
                    thinkingEffort: { mode: 'default', value: null },
                })
            );
            expect(!('thinking' in bodyOf(0)) && !('reasoning_effort' in bodyOf(0)), 'default sends no thinking params');

            reset(reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'explicit' }), chatChunk({}, 'stop')])));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'deepseek-flash',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'high' },
                })
            );
            expect(
                json(thinkingOf(0)) === json({ type: 'enabled' }) && bodyOf(0).reasoning_effort === 'high',
                `explicit sends thinking+reasoning_effort (got ${json(bodyOf(0))})`
            );

            reset(reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'off' }), chatChunk({}, 'stop')])));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'deepseek-flash',
                    timeout: 20000,
                    thinkingEffort: { mode: 'off', value: null },
                })
            );
            expect(
                json(thinkingOf(0)) === json({ type: 'disabled' }),
                `off disables thinking (got ${json(thinkingOf(0))})`
            );
        },
    },
    {
        name: 'deepseek falls back to the legacy body when the params are rejected',
        body: async () => {
            reset(
                reply('/deepseek/v1/chat/completions', 400, errorBody('Invalid reasoning_effort for this model')),
                reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'downgraded' }), chatChunk({}, 'stop')]))
            );
            const platform = new DeepSeekPlatform();
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'high' },
                    })
                )
            );
            expect(result.text === 'downgraded', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry (got ${recorded.length})`);
            expect(bodyOf(1).reasoning_effort === undefined && !('thinking' in bodyOf(1)), `the retry is the legacy body (got ${json(bodyOf(1))})`);
            expect(
                lines.some((line) => line.includes('rejected thinking effort high; retrying with the provider default')),
                `the downgrade is logged (got ${json(lines)})`
            );
        },
    },
    {
        name: 'deepseek tool rounds share the downgrade with the single request path',
        body: async () => {
            reset(
                reply('/deepseek/v1/chat/completions', 400, errorBody('reasoning_effort is not supported')),
                reply('/deepseek/v1/chat/completions', 200, chatBody([chatChunk({ content: 'no tools needed' }), chatChunk({}, 'stop')]))
            );
            const platform = new DeepSeekPlatform();
            const { result } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'deepseek-flash',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'high' },
                        tools: createTurnTools([weatherTool]),
                    })
                )
            );
            expect(result.text === 'no tools needed', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry (got ${recorded.length})`);
            expect(bodyOf(0).reasoning_effort === 'high', 'the rejected attempt carried the effort');
            expect(bodyOf(1).reasoning_effort === undefined, 'the retry dropped it');
        },
    },
    {
        name: 'mimo keeps thinking enabled by default, disables it for off and adds effort for explicit',
        body: async () => {
            const platform = new MimoPlatform();
            reset(reply('/mimo/v1/chat/completions', 200, chatBody([chatChunk({ content: 'legacy' }), chatChunk({}, 'stop')])));
            await drainQuietly(() => platform.sendMessage(userTurn('hi'), { model: 'mimo-v2.6-pro', timeout: 20000 }));
            expect(json(thinkingOf(0)) === json({ type: 'enabled' }), `legacy keeps thinking enabled (got ${json(bodyOf(0))})`);

            reset(reply('/mimo/v1/chat/completions', 200, chatBody([chatChunk({ content: 'explicit' }), chatChunk({}, 'stop')])));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'mimo-v2.6-pro',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'high' },
                })
            );
            expect(
                json(thinkingOf(0)) === json({ type: 'enabled' }) && bodyOf(0).reasoning_effort === 'high',
                `explicit adds the effort (got ${json(bodyOf(0))})`
            );

            reset(reply('/mimo/v1/chat/completions', 200, chatBody([chatChunk({ content: 'off' }), chatChunk({}, 'stop')])));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'mimo-v2.6-pro',
                    timeout: 20000,
                    thinkingEffort: { mode: 'off', value: null },
                })
            );
            expect(json(thinkingOf(0)) === json({ type: 'disabled' }), `off disables thinking (got ${json(thinkingOf(0))})`);
        },
    },
    {
        name: 'mimo falls back to thinking enabled when the effort is rejected',
        body: async () => {
            reset(
                reply('/mimo/v1/chat/completions', 400, errorBody('reasoning_effort is not supported')),
                reply('/mimo/v1/chat/completions', 200, chatBody([chatChunk({ content: 'downgraded' }), chatChunk({}, 'stop')]))
            );
            const platform = new MimoPlatform();
            const { result } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'mimo-v2.6-pro',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'high' },
                    })
                )
            );
            expect(result.text === 'downgraded', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry (got ${recorded.length})`);
            expect(
                json(thinkingOf(1)) === json({ type: 'enabled' }) && bodyOf(1).reasoning_effort === undefined,
                `the retry is the legacy body (got ${json(bodyOf(1))})`
            );
        },
    },
    {
        name: 'grok 4.7 stays silent by default, sends the explicit effort and drops it for off',
        body: async () => {
            const platform = new GrokPlatform();
            reset(reply('/grok/v1/responses', 200, responsesAnswer('legacy answer')));
            await drainQuietly(() => platform.sendMessage(userTurn('hi'), { model: 'grok-4.7', timeout: 20000 }));
            expect(!('reasoning' in bodyOf(0)), `legacy 4.7 sends no reasoning (got ${json(bodyOf(0))})`);

            reset(reply('/grok/v1/responses', 200, responsesAnswer('explicit answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'grok-4.7',
                    timeout: 20000,
                    thinkingEffort: { mode: 'explicit', value: 'low' },
                })
            );
            expect(effortOf(0) === 'low', `explicit sends the effort (got ${json(reasoningOf(0))})`);

            reset(reply('/grok/v1/responses', 200, responsesAnswer('off answer')));
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), {
                    model: 'grok-4.7',
                    timeout: 20000,
                    thinkingEffort: { mode: 'off', value: null },
                })
            );
            expect(!('reasoning' in bodyOf(0)), 'off sends no reasoning');
        },
    },
    {
        name: 'grok multi-agent keeps the legacy explicit high',
        body: async () => {
            reset(reply('/grok/v1/responses', 200, responsesAnswer('multi-agent answer')));
            const platform = new GrokPlatform();
            await drainQuietly(() =>
                platform.sendMessage(userTurn('hi'), { model: 'grok-4.20-multi-agent-0309', timeout: 20000 })
            );
            expect(json(reasoningOf(0)) === json({ effort: 'high' }), `multi-agent keeps high (got ${json(bodyOf(0).reasoning)})`);
        },
    },
    {
        name: 'grok downgrades a rejected explicit effort once',
        body: async () => {
            reset(
                reply('/grok/v1/responses', 400, errorBody('Unsupported reasoning effort: xhigh')),
                reply('/grok/v1/responses', 200, responsesAnswer('downgraded answer'))
            );
            const platform = new GrokPlatform();
            const { result, lines } = await captureConsole(async () =>
                drain(() =>
                    platform.sendMessage(userTurn('hi'), {
                        model: 'grok-4.7',
                        timeout: 20000,
                        thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                    })
                )
            );
            expect(result.text === 'downgraded answer', `the retry answers (got ${json(result)})`);
            expect(recorded.length === 2, `one downgrade retry, no candidate walk (got ${recorded.length})`);
            expect(effortOf(0) === 'xhigh' && effortOf(1) === 'high', `xhigh then high (got ${json([effortOf(0), effortOf(1)])})`);
            expect(
                lines.some((line) => line.includes('rejected thinking effort xhigh; retrying with high')),
                `the downgrade is logged (got ${json(lines)})`
            );
        },
    },
    {
        name: 'grok does not downgrade on 401, 404 or 429',
        body: async () => {
            const platform = new GrokPlatform();
            for (const status of [401, 404, 429]) {
                reset(reply('/grok/v1/responses', status, errorBody('reasoning effort permission problem')));
                const { result, lines } = await captureConsole(async () =>
                    drain(() =>
                        platform.sendMessage(userTurn('hi'), {
                            model: 'grok-4.7',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'xhigh' },
                        })
                    )
                );
                expect(result.error !== null, `${status}: the reply fails`);
                expect(recorded.length >= 1, `${status}: at least one request (got ${recorded.length})`);
                expect(
                    recorded.every((entry) => asRecord(entry.body.reasoning).effort === 'xhigh'),
                    `${status}: every body keeps xhigh (got ${json(recorded.map((entry) => entry.body.reasoning))})`
                );
                expect(
                    !lines.some((line) => line.includes('rejected thinking effort')),
                    `${status}: no downgrade was logged (got ${json(lines)})`
                );
            }
        },
    },
    {
        name: 'deepseek and mimo do not downgrade on 401, 404 or 429',
        body: async () => {
            const deepseek = new DeepSeekPlatform();
            const mimo = new MimoPlatform();
            const attempts: Array<{ status: number; path: string; send: () => Promise<AsyncIterable<StreamChunk>> }> = [];
            for (const status of [401, 404, 429]) {
                attempts.push({
                    status,
                    path: '/deepseek/v1/chat/completions',
                    send: () =>
                        deepseek.sendMessage(userTurn('hi'), {
                            model: 'deepseek-flash',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'high' },
                        }),
                });
                attempts.push({
                    status,
                    path: '/mimo/v1/chat/completions',
                    send: () =>
                        mimo.sendMessage(userTurn('hi'), {
                            model: 'mimo-v2.6-pro',
                            timeout: 20000,
                            maxRetries: 1,
                            thinkingEffort: { mode: 'explicit', value: 'high' },
                        }),
                });
            }
            for (const attempt of attempts) {
                reset(reply(attempt.path, attempt.status, errorBody('reasoning effort permission problem')));
                const { result, lines } = await captureConsole(async () => drain(attempt.send));
                expect(result.error !== null, `${attempt.path} ${attempt.status}: the reply fails`);
                expect(recorded.length >= 1, `${attempt.path} ${attempt.status}: at least one request (got ${recorded.length})`);
                expect(
                    recorded.every((entry) => entry.body.reasoning_effort === 'high'),
                    `${attempt.path} ${attempt.status}: every body keeps the effort (got ${json(recorded.map((entry) => entry.body.reasoning_effort))})`
                );
                expect(
                    !lines.some((line) => line.includes('rejected thinking effort')),
                    `${attempt.path} ${attempt.status}: no downgrade was logged (got ${json(lines)})`
                );
            }
        },
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

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
stub.closeAllConnections();
stub.close();
reportResults(results);
