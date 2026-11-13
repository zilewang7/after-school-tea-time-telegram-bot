/**
 * Offline cases for the thinking-effort wire of every platform (design
 * 2026-1113-1742 §3.3 / appendix D): the request bodies of
 * `PlatformConfig.thinkingEffort` in its three modes, the legacy body when the
 * field is absent, the one-shot downgrade after a level 400, and the rule that
 * 401/429 never count as a thinking rejection.
 *
 * One local stub answers every OpenAI-compatible platform (each under its own
 * base path) with scripted rounds. Gemini has its own file
 * (gemini-thinking-level.mts). No network, no database.
 *
 * Run: npx tsx scripts/offline/platform-thinking-wire.mts
 */
import { createServer } from 'node:http';
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
        if (!next || next.path !== path) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: `unexpected request to ${path}` } }));
            return;
        }
        response.writeHead(next.status, { 'Content-Type': 'application/json' });
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
