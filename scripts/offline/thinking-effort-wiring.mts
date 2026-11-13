/**
 * Cross-layer integration cases for the chat thinking level (thinking-effort
 * design 2026-1113-1742 §3.2/§3.3/§3.4/§6): one chain from the stored
 * `chat_settings.thinkingEffort` through the resolver, the platform request,
 * `reply_metrics` and the continue check.
 *
 * Bench: `support/resume-bench.mts` (the real chat/retry/continue handlers and
 * the real Gemini platform on the fake Vertex endpoint) plus a local
 * OpenAI-compatible stub for the DeepSeek/MiMo chat paths. Nothing here touches
 * the network.
 *
 * Known limitation asserted below (design §1.4 makes the fallback column
 * optional): a platform-level 400 downgrade only logs; `reply_metrics` keeps
 * the pre-request resolution (the catalog clamp is what the fallback column
 * records).
 *
 * Run: pnpm test:offline thinking-effort-wiring
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { answer } from './support/gemini-loop-fixtures.mts';
import {
    FULL_USER_ID,
    asRecord,
    createResumeBench,
    json,
    quietCase,
    takeChatId,
    webLookup,
    type AskedReply,
} from './support/resume-bench.mts';
import type { PlatformConfig } from '../../src/ai/types.js';
import type { ReplyMetricRecord } from '../../src/db/queries/reply-metric-rows.js';

// ---------------------------------------------------------------------------
// The OpenAI-compatible stub behind the DeepSeek and MiMo platforms
// ---------------------------------------------------------------------------

interface StubRequest {
    readonly path: string;
    readonly body: Record<string, unknown>;
}

type StubMode = 'ok' | 'reject-high' | 'once-429' | 'always-401';

const stubRequests: StubRequest[] = [];
let stubMode: StubMode = 'ok';
let stubChatRequests = 0;

const resetStub = (mode: StubMode = 'ok'): void => {
    stubRequests.length = 0;
    stubMode = mode;
    stubChatRequests = 0;
};

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'wiring-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/** One complete chat-completions stream: a thought, a text and the usage chunk */
const okStream = (): string =>
    [
        sse(chatChunk({ role: 'assistant', content: '' })),
        sse(chatChunk({ reasoning_content: '想一想' })),
        sse(chatChunk({ content: '好的，收到' })),
        sse(chatChunk({}, 'stop')),
        sse({
            ...chatChunk({}),
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        'data: [DONE]\n\n',
    ].join('');

const writeJson = (response: ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
};

const stubServer = createServer((request, response) => {
    void readBody(request).then((raw) => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        let body: Record<string, unknown> = {};
        try {
            body = asRecord(JSON.parse(raw));
        } catch {
            body = {};
        }
        stubRequests.push({ path, body });
        const isChat = path.endsWith('/chat/completions');
        if (isChat) stubChatRequests += 1;
        if (stubMode === 'always-401') {
            writeJson(response, 401, 'invalid api key');
            return;
        }
        if (isChat && stubMode === 'once-429' && stubChatRequests === 1) {
            writeJson(response, 429, 'rate limited');
            return;
        }
        if (isChat && stubMode === 'reject-high' && body.reasoning_effort === 'high') {
            writeJson(response, 400, 'reasoning effort is not supported');
            return;
        }
        if (!isChat) {
            writeJson(response, 404, `unexpected path ${path}`);
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(okStream());
    });
});
await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', () => resolve()));
const stubAddress = stubServer.address();
if (stubAddress === null || typeof stubAddress === 'string') throw new Error('the stub server has no TCP address');
const stubBase = `http://127.0.0.1:${stubAddress.port}/v1`;
process.once('exit', () => stubServer.close());

// Read by the platform singletons when the bench first imports them
process.env.DEEPSEEK_API_URL = stubBase;
process.env.DEEPSEEK_API_KEY = 'offline-stub';
process.env.MIMO_API_URL = stubBase;
process.env.MIMO_API_KEY = 'offline-stub';
process.env.OPENAI_API_URL = stubBase;
process.env.OPENAI_API_KEY = 'offline-stub';

const bench = await createResumeBench();
const { updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const { getPlatform } = await import('../../src/ai/platform-factory.js');
const { THINKING_EFFORT_CHANGED_NOTICE } = await import('../../src/reply/resume/resume-facts.js');

/** Every PlatformConfig the DeepSeek and MiMo singletons were handed */
const deepseekConfigs: PlatformConfig[] = [];
const mimoConfigs: PlatformConfig[] = [];

const watchPlatform = (probeModel: string, sink: PlatformConfig[]): void => {
    const platform = getPlatform(probeModel);
    const original = platform.sendMessage.bind(platform);
    platform.sendMessage = (messages, config) => {
        sink.push(config);
        return original(messages, config);
    };
};
watchPlatform('deepseek-flash', deepseekConfigs);
watchPlatform('mimo-v2.6-pro', mimoConfigs);

// ---------------------------------------------------------------------------
// Reading what one reply did
// ---------------------------------------------------------------------------

const FULL_ACTOR = { userId: FULL_USER_ID, isOwner: false };

const setChat = async (
    chatId: number,
    patch: { readonly model?: string; readonly thinkingEffort?: string | null }
): Promise<void> => {
    await updateChatSettings({ chatId, patch, actor: FULL_ACTOR });
};

/** Store the setting, then run one Gemini reply with one scripted final answer */
const askGemini = async (chatId: number, model: string, thinkingEffort: string | null): Promise<AskedReply> => {
    await setChat(chatId, { model, thinkingEffort });
    bench.vertex.reset([answer('收到')]);
    return bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
};

const lastGeminiConfig = (): PlatformConfig => {
    const config = bench.configs.at(-1);
    if (config === undefined) throw new Error('no Gemini platform config was recorded');
    return config;
};

const lastGeminiBody = (): Record<string, unknown> => {
    const request = bench.vertex.requests.at(-1);
    if (request === undefined) throw new Error('no Gemini request was recorded');
    return request.body;
};

const thinkingConfigOf = (body: Record<string, unknown>): Record<string, unknown> =>
    asRecord(asRecord(body.generationConfig).thinkingConfig);

const chatCompletions = (): readonly StubRequest[] =>
    stubRequests.filter((request) => request.path.endsWith('/chat/completions'));

const lastRow = async (reply: AskedReply): Promise<ReplyMetricRecord> => {
    const rows = await bench.rowsOf(reply);
    const row = rows.at(-1);
    if (row === undefined) throw new Error('the reply has no metrics row');
    return row;
};

const thinkingColumns = (row: ReplyMetricRecord) => ({
    requested: row.thinkingEffortRequested,
    sent: row.thinkingEffortSent,
    fallback: row.thinkingEffortFallback,
});

const cases: CaseResult[] = [];

// ---- the Gemini wire follows the stored setting ----

cases.push(
    await runCase(
        'no chat setting: the vendor default goes out (no level field) and the row records NULLs',
        quietCase(async () => {
            const reply = await askGemini(takeChatId(), 'gemini-4-hydrogen', null);
            const config = lastGeminiConfig();
            expect(
                json(config.thinkingEffort) === json({ mode: 'default', value: null }),
                `the request carries the resolved default (got ${json(config.thinkingEffort)})`
            );
            const thinking = thinkingConfigOf(lastGeminiBody());
            expect(thinking.includeThoughts === true, 'thoughts stay on, as before');
            expect(
                !('thinkingLevel' in thinking) && !('thinkingBudget' in thinking),
                `no level and no budget means the vendor default (got ${json(thinking)})`
            );
            expect(
                json(thinkingColumns(await lastRow(reply))) === json({ requested: null, sent: null, fallback: null }),
                'the metrics row has nothing explicit'
            );
        })
    )
);

cases.push(
    await runCase(
        'hydrogen stored high: the wire carries the explicit level and the row names it',
        quietCase(async () => {
            const reply = await askGemini(takeChatId(), 'gemini-4-hydrogen', 'high');
            expect(
                json(lastGeminiConfig().thinkingEffort) === json({ mode: 'explicit', value: 'high' }),
                `the resolved value is explicit high (got ${json(lastGeminiConfig().thinkingEffort)})`
            );
            const thinking = thinkingConfigOf(lastGeminiBody());
            expect(thinking.thinkingLevel === 'HIGH', `the wire level is HIGH (got ${json(thinking)})`);
            expect(!('thinkingBudget' in thinking), 'an explicit level replaces the budget');
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'high', sent: 'high', fallback: null }),
                'requested and sent are both high, no chain'
            );
        })
    )
);

cases.push(
    await runCase(
        'xhigh on argon clamps to high: wire HIGH, metrics fallback xhigh->high',
        quietCase(async () => {
            const reply = await askGemini(takeChatId(), 'gemini-4-argon', 'xhigh');
            expect(
                json(lastGeminiConfig().thinkingEffort) === json({ mode: 'explicit', value: 'high' }),
                `the clamped value is explicit high (got ${json(lastGeminiConfig().thinkingEffort)})`
            );
            expect(thinkingConfigOf(lastGeminiBody()).thinkingLevel === 'HIGH', 'the wire gets HIGH');
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'xhigh', sent: 'high', fallback: 'xhigh->high' }),
                'the clamp and its chain reach the row'
            );
        })
    )
);

cases.push(
    await runCase(
        'an unknown model keeps the legacy wire whatever the chat setting says',
        quietCase(async () => {
            const unknown = 'gemini-9-mystery';
            await askGemini(takeChatId(), unknown, null);
            const withoutConfig = lastGeminiConfig().thinkingEffort;
            const withoutWire = thinkingConfigOf(lastGeminiBody());

            const withSetting = await askGemini(takeChatId(), unknown, 'xhigh');
            const withConfig = lastGeminiConfig().thinkingEffort;
            const withWire = thinkingConfigOf(lastGeminiBody());

            expect(
                withoutConfig === undefined && withConfig === undefined,
                `no PlatformConfig fragment for a model without data (got ${json(withoutConfig)} / ${json(withConfig)})`
            );
            expect(
                json(withoutWire) === json(withWire),
                `the setting does not change the legacy wire (${json(withoutWire)} vs ${json(withWire)})`
            );
            expect(
                withWire.includeThoughts === true && withWire.thinkingBudget === -1,
                `the pre-Gemini-4 budget policy is unchanged (got ${json(withWire)})`
            );
            expect(
                json(thinkingColumns(await lastRow(withSetting))) ===
                    json({ requested: 'xhigh', sent: null, fallback: null }),
                'the row keeps the raw setting but sent nothing explicit'
            );
        })
    )
);

// ---- the OpenAI-compatible platforms: off and the degradation chain ----

cases.push(
    await runCase(
        'deepseek off: the thinking switch is disabled and the row records off',
        quietCase(async () => {
            resetStub();
            const chatId = takeChatId();
            await setChat(chatId, { model: 'deepseek-flash', thinkingEffort: 'off' });
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
            const requests = chatCompletions();
            expect(requests.length >= 1, `the deepseek lane was called (got ${requests.length})`);
            const body = requests.at(-1)?.body ?? {};
            expect(json(body.thinking) === json({ type: 'disabled' }), `thinking is disabled (got ${json(body.thinking)})`);
            expect(!('reasoning_effort' in body), 'no effort rides the off switch');
            expect(
                json(deepseekConfigs.at(-1)?.thinkingEffort) === json({ mode: 'off', value: null }),
                `the config fragment is off (got ${json(deepseekConfigs.at(-1)?.thinkingEffort)})`
            );
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'off', sent: 'off', fallback: null }),
                'the metrics row records off'
            );
        })
    )
);

cases.push(
    await runCase(
        'mimo off: the toggle-only model disables thinking and records off',
        quietCase(async () => {
            resetStub();
            const chatId = takeChatId();
            await setChat(chatId, { model: 'mimo-v2.6-pro', thinkingEffort: 'off' });
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
            const body = chatCompletions().at(-1)?.body ?? {};
            expect(json(body.thinking) === json({ type: 'disabled' }), `thinking is disabled (got ${json(body.thinking)})`);
            expect(
                json(mimoConfigs.at(-1)?.thinkingEffort) === json({ mode: 'off', value: null }),
                `the config fragment is off (got ${json(mimoConfigs.at(-1)?.thinkingEffort)})`
            );
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'off', sent: 'off', fallback: null }),
                'the metrics row records off'
            );
        })
    )
);

cases.push(
    await runCase(
        'a 400 on the requested effort retries the legacy body once (metrics keep the request-time value)',
        quietCase(async (log) => {
            resetStub('reject-high');
            const chatId = takeChatId();
            await setChat(chatId, { model: 'deepseek-flash', thinkingEffort: 'high' });
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
            const requests = chatCompletions();
            expect(requests.length === 2, `the rejected effort is retried once (got ${requests.length})`);
            const first = requests[0]?.body ?? {};
            const retried = requests[1]?.body ?? {};
            expect(
                first.reasoning_effort === 'high' && json(first.thinking) === json({ type: 'enabled' }),
                `the first request asks for high (got ${json(first)})`
            );
            expect(
                !('reasoning_effort' in retried) && !('thinking' in retried),
                `the retry falls back to the legacy body (got ${json(retried)})`
            );
            expect(log.has('rejected thinking effort'), 'the downgrade is logged');
            // Known limitation (design §1.4 makes the fallback column optional):
            // the platform's 400 downgrade only logs, the row keeps what the
            // resolver decided before the request.
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'high', sent: 'high', fallback: null }),
                'the row keeps the pre-request resolution'
            );
        })
    )
);

cases.push(
    await runCase(
        'a 401 is not an effort rejection: one request, no downgrade, the row keeps high',
        quietCase(async (log) => {
            resetStub('always-401');
            const chatId = takeChatId();
            await setChat(chatId, { model: 'deepseek-flash', thinkingEffort: 'high' });
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
            const requests = chatCompletions();
            expect(requests.length === 1, `an auth failure is not retried as an effort problem (got ${requests.length})`);
            expect(
                requests.every((request) => request.body.reasoning_effort === 'high'),
                'the request keeps the effort it asked for'
            );
            expect(!log.has('rejected thinking effort'), 'the downgrade path is not entered');
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'high', sent: 'high', fallback: null }),
                'the failed attempt still records the request'
            );
            const version = await bench.latestVersion(reply);
            expect(version.errorMessage !== undefined, 'the reply fails with the auth error');
        })
    )
);

cases.push(
    await runCase(
        'a transient 429 is retried by transport, not by the effort downgrade',
        quietCase(async (log) => {
            resetStub('once-429');
            const chatId = takeChatId();
            await setChat(chatId, { model: 'deepseek-flash', thinkingEffort: 'high' });
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 你好');
            const requests = chatCompletions();
            expect(requests.length >= 2, `the rate limit is retried (got ${requests.length})`);
            expect(
                requests.every((request) => request.body.reasoning_effort === 'high'),
                'every transport attempt keeps the requested effort'
            );
            expect(!log.has('rejected thinking effort'), 'the effort downgrade path is not entered');
            expect(
                json(thinkingColumns(await lastRow(reply))) ===
                    json({ requested: 'high', sent: 'high', fallback: null }),
                'the successful retry records what went out'
            );
        })
    )
);

// ---- retry and continue ----

cases.push(
    await runCase(
        'a retry sends the chat setting current at the click, not the failed attempt\'s',
        quietCase(async () => {
            const chatId = takeChatId();
            const first = await askGemini(chatId, 'gemini-4-hydrogen', 'low');
            await setChat(chatId, { thinkingEffort: 'high' });
            bench.vertex.reset([answer('重试完成')]);
            await bench.retryReply(first);
            const config = lastGeminiConfig();
            expect(
                json(config.thinkingEffort) === json({ mode: 'explicit', value: 'high' }),
                `the retry carries the current setting (got ${json(config.thinkingEffort)})`
            );
            expect(thinkingConfigOf(lastGeminiBody()).thinkingLevel === 'HIGH', 'the wire level is HIGH');
        })
    )
);

cases.push(
    await runCase(
        'a changed level blocks 继续; changing it back resumes the same checkpoint on the vendor default',
        quietCase(async () => {
            const chatId = takeChatId();
            await setChat(chatId, { model: 'gemini-4-carbon', thinkingEffort: null });
            const reply = await bench.failedAfterRound1(
                { label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] },
                { chatId }
            );
            const kept = bench.entryOf(reply);
            expect(
                kept?.request.thinkingEffort === null && kept.request.thinkingEffortSent === null,
                'the checkpoint records the level the interrupted version asked for'
            );

            await setChat(chatId, { thinkingEffort: 'high' });
            bench.telegram.reset();
            await bench.press(reply, 'resp:continue');
            expect(
                bench.toasts().includes(THINKING_EFFORT_CHANGED_NOTICE),
                `the changed level blocks the continue (got ${json(bench.toasts())})`
            );
            expect(bench.entryOf(reply) !== undefined, 'the checkpoint is kept for a later click');

            await setChat(chatId, { thinkingEffort: null });
            bench.vertex.reset([answer('继续完成')]);
            bench.telegram.reset();
            await bench.continueReply(reply);
            expect(bench.toasts().includes('继续中...'), `the restored setting continues (got ${json(bench.toasts())})`);
            const version = await bench.latestVersion(reply);
            expect(
                version.text.includes('继续完成') && version.errorMessage === undefined,
                'the resumed version ends normally'
            );
            const resumedThinking = thinkingConfigOf(lastGeminiBody());
            expect(
                !('thinkingLevel' in resumedThinking) && !('thinkingBudget' in resumedThinking),
                `the resumed request is back to the vendor default (got ${json(resumedThinking)})`
            );
            const rows = await bench.rowsOf(reply);
            const resumed = rows.at(-1);
            expect(
                resumed !== undefined &&
                    json(thinkingColumns(resumed)) === json({ requested: null, sent: null, fallback: null }),
                'the resumed attempt records the restored setting'
            );
        })
    )
);

cases.push(
    await runCase(
        'a checkpoint taken with high resumes with the same explicit level',
        quietCase(async () => {
            const chatId = takeChatId();
            await setChat(chatId, { model: 'gemini-4-carbon', thinkingEffort: 'high' });
            const reply = await bench.failedAfterRound1(
                { label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] },
                { chatId }
            );
            const kept = bench.entryOf(reply);
            expect(
                kept?.request.thinkingEffort === 'high' && kept.request.thinkingEffortSent === 'high',
                'the checkpoint records the explicit level the interrupted version asked for'
            );

            bench.vertex.reset([answer('继续完成')]);
            bench.telegram.reset();
            await bench.continueReply(reply);
            expect(bench.toasts().includes('继续中...'), `the unchanged level continues (got ${json(bench.toasts())})`);
            expect(
                json(lastGeminiConfig().thinkingEffort) === json({ mode: 'explicit', value: 'high' }),
                `the resumed request carries the same level (got ${json(lastGeminiConfig().thinkingEffort)})`
            );
            expect(thinkingConfigOf(lastGeminiBody()).thinkingLevel === 'HIGH', 'the resumed wire level is HIGH');
            const rows = await bench.rowsOf(reply);
            const resumed = rows.at(-1);
            expect(
                resumed !== undefined &&
                    json(thinkingColumns(resumed)) === json({ requested: 'high', sent: 'high', fallback: null }),
                'the resumed attempt records the same setting'
            );
        })
    )
);

await bench.close();
await new Promise<void>((resolve) => stubServer.close(() => resolve()));
reportResults(cases);
