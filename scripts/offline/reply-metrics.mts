/**
 * Offline cases for reply_metrics (design §6.5, §11 phase 3): one row per
 * attempt with the right outcome and errorKind, versionId and imageCount, a
 * retry's own row on the next version, the usage sink adding up rounds and
 * keeping the finished ones after a stop, a failed metrics write that never
 * blocks the finalize, the hourly cleanup leaving the table alone, and the
 * real handlers (chat reply, retry, /picgpt) wiring timings, context size and
 * usage through to the row. Then the recovery, Priority PayGo and resume
 * columns: automatic retries, the requested and served tier, the checkpoint
 * facts of the draft, NULL when there was nothing, and the priority sums of
 * the usage aggregate.
 *
 * Run: npx tsx scripts/offline/reply-metrics.mts
 */
import { createServer } from 'node:http';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { callbackUpdate, contextOf, createFakeTelegram, messageUpdate } from './fake-telegram.mts';
import type { StreamChunk } from '../../src/ai/types.js';

// ---- model stub: MiMo chat completions (with usage) and the OpenAI images API ----

const MIMO_USAGE = {
    prompt_tokens: 812,
    prompt_tokens_details: { cached_tokens: 512 },
    completion_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 25 },
    total_tokens: 852,
};
const IMAGES_USAGE = { input_tokens: 31, output_tokens: 1056, total_tokens: 1087 };
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

const stubRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'offline-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mimo-v2.6-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const modelStub = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://stub').pathname;
        const raw = Buffer.concat(parts).toString('utf8');
        stubRequests.push({ path, body: raw.startsWith('{') ? JSON.parse(raw) : {} });
        if (path === '/v1/chat/completions') {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(
                [
                    sse(chatChunk({ role: 'assistant', content: '' })),
                    sse(chatChunk({ reasoning_content: '想一想' })),
                    sse(chatChunk({ content: '好的，收到' })),
                    sse(chatChunk({}, 'stop')),
                    sse({ ...chatChunk({}), choices: [], usage: MIMO_USAGE }),
                    'data: [DONE]\n\n',
                ].join('')
            );
            return;
        }
        // A reference image makes it images.edit (multipart), none images.generate
        if (path === '/v1/images/generations' || path === '/v1/images/edits') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ created: 0, data: [{ b64_json: PNG_BASE64 }], usage: IMAGES_USAGE }));
            return;
        }
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `unexpected request to ${path}` } }));
    });
});
await new Promise<void>((resolve) => modelStub.listen(0, '127.0.0.1', () => resolve()));
const stubAddress = modelStub.address();
if (stubAddress === null || typeof stubAddress === 'string') throw new Error('the model stub has no TCP address');
process.once('exit', () => modelStub.close());

// Read by the platform singletons when they are first imported
process.env.MIMO_API_URL = `http://127.0.0.1:${stubAddress.port}/v1`;
process.env.MIMO_API_KEY = 'offline-stub';
process.env.OPENAI_API_URL = `http://127.0.0.1:${stubAddress.port}/v1`;
process.env.OPENAI_API_KEY = 'offline-stub';
process.env.DEFAULT_MODEL = 'mimo-v2.6-flash';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';

await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { sequelize } = await import('../../src/db/config.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const { getActiveSession, listActiveSessions, startRetry } = await import('../../src/services/bot-message-service.js');
const { markRequestStarted, recordCheckpointRounds, recordContextSize, recordResumedRounds } = await import(
    '../../src/services/reply-metrics-draft.js'
);
const { listRecentReplyErrors } = await import('../../src/services/recent-reply-errors.js');
const { getLastCleanupRun } = await import('../../src/services/cleanup-status.js');
const { createUsageSink } = await import('../../src/ai/usage/index.js');
const { classifyErrorKind, summarizeErrorMessage } = await import('../../src/shared/error-kind.js');
const { AppError } = await import('../../src/shared/errors.js');
const { aggregateUsageByModelRoute, findReplyMetricsByReply, insertReplyMetric } = await import(
    '../../src/db/queries/reply-metrics.js'
);
const { listReplyMetricsByReply } = await import('../../src/panel/views/reply-metrics-view.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');
const { handleReply } = await import('../../src/reply/chat-handler.js');
const { handleRetryRequest } = await import('../../src/reply/retry-handler.js');
const { handlePicgptCommand } = await import('../../src/reply/commands/picgpt-handler.js');
const { OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');

type ChatContext = import('../../src/reply/response-handler.js').ChatContext;
type ReplyMetricRecord = import('../../src/db/queries/reply-metrics.js').ReplyMetricRecord;
type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;
type ContextIndexEntry = import('../../src/reply/context-index.js').ContextIndexEntry;

const USER_ID = 5150;
const json = (value: unknown): string => JSON.stringify(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Console output while `body` runs, kept instead of printed */
const capture = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
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
        Object.assign(console, original);
    }
};

/** A chat context exactly as a trigger message creates it */
const startReply = async (
    chatId: number,
    options: { model?: string; commandType?: 'chat' | 'picbanana' | 'picgpt' } = {}
): Promise<ChatContext> => {
    const telegram = createFakeTelegram();
    const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: USER_ID, text: '你好' }), telegram);
    const { result } = await capture(() =>
        responseHandler.createChatContext(ctx, {
            model: options.model ?? 'deepseek-flash',
            ...(options.commandType ? { commandType: options.commandType } : {}),
        })
    );
    if (!result) throw new Error('no chat context');
    return result;
};

const contextIndexOf = (imageCounts: readonly number[]): Map<number, ContextIndexEntry> =>
    new Map(
        imageCounts.map((imageCount, index) => [
            index + 1,
            { number: index + 1, messageId: 1000 + index, fromBot: false, images: [], imageCount },
        ])
    );

/** Run a stream through the real processor and final delivery */
const deliver = async (chatContext: ChatContext, stream: AsyncIterable<StreamChunk>): Promise<void> => {
    await capture(async () => {
        const response = await responseHandler.processStream(stream, chatContext, 0);
        await responseHandler.sendFinalResponse(chatContext, response);
    });
};

const rowsOf = async (chatContext: ChatContext): Promise<ReplyMetricRecord[]> =>
    findReplyMetricsByReply(chatContext.chatId, chatContext.session.firstMessageId);

const onlyRow = async (chatContext: ChatContext): Promise<ReplyMetricRecord> => {
    const rows = await rowsOf(chatContext);
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) throw new Error(`expected one row, got ${rows.length}`);
    return row;
};

const roundUsage = (promptTokens: number, outputTokens: number) => ({
    promptTokens,
    cachedTokens: 0,
    cacheWriteTokens: null,
    outputTokens,
    thoughtsTokens: null,
    imageOutputTokens: null,
});

/** The columns added for automatic recovery, Priority PayGo and resume */
const recoveryColumnsOf = (row: ReplyMetricRecord | undefined) => ({
    roundRetries: row?.roundRetries,
    tierRequested: row?.tierRequested,
    priorityRounds: row?.priorityRounds,
    priorityPromptTokens: row?.priorityPromptTokens,
    priorityCachedTokens: row?.priorityCachedTokens,
    priorityOutputTokens: row?.priorityOutputTokens,
    resumedRounds: row?.resumedRounds,
    checkpointRounds: row?.checkpointRounds,
});

const NO_RECOVERY_COLUMNS = {
    roundRetries: null,
    tierRequested: null,
    priorityRounds: null,
    priorityPromptTokens: null,
    priorityCachedTokens: null,
    priorityOutputTokens: null,
    resumedRounds: null,
    checkpointRounds: null,
};

/** A stored row with every column given; tokens of one round with usage */
const storedRow = (chatId: number, firstMessageId: number, fields: Partial<ReplyMetricInput>): ReplyMetricInput => ({
    chatId,
    userMessageId: firstMessageId - 1,
    firstMessageId,
    versionId: 1,
    triggerUserId: null,
    model: 'gemini-4-argon',
    platform: 'gemini',
    route: null,
    commandType: 'chat',
    isRetry: false,
    startedAt: new Date(Date.now() - 60_000),
    requestStartedAt: null,
    firstChunkAt: null,
    finishedAt: new Date(),
    outcome: 'ok',
    errorKind: null,
    errorSummary: null,
    rounds: 1,
    toolCalls: 0,
    toolFailures: 0,
    toolUsage: [],
    promptTokens: 1000,
    cachedTokens: 400,
    cacheWriteTokens: null,
    outputTokens: 100,
    thoughtsTokens: null,
    imageOutputTokens: null,
    contextMessages: 1,
    contextImages: 0,
    textChars: 1,
    thinkingChars: 0,
    hasImage: false,
    imageCount: 0,
    hasSticker: false,
    hasFile: false,
    ...NO_RECOVERY_COLUMNS,
    ...fields,
});

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the usage sink adds rounds up, counts rounds without usage, and keeps unreported fields null',
        body: async () => {
            const sink = createUsageSink();
            expect(sink.totals().rounds === 0 && sink.totals().promptTokens === null, 'empty: no rounds, nothing known');
            sink.addRound({ ...roundUsage(100, 10), thoughtsTokens: 4 });
            sink.addRound(null);
            sink.addRound(roundUsage(250, 30));
            sink.setRoute('large-media');
            const totals = sink.totals();
            expect(
                totals.rounds === 3 &&
                    totals.promptTokens === 350 &&
                    totals.outputTokens === 40 &&
                    totals.cachedTokens === 0 &&
                    totals.thoughtsTokens === 4 &&
                    totals.cacheWriteTokens === null &&
                    totals.imageOutputTokens === null &&
                    totals.route === 'large-media',
                `summed (got ${json(totals)})`
            );
        },
    },
    {
        name: 'ok: one row with timings, context size, usage, tools and character counts',
        body: async () => {
            const chatContext = await startReply(-1005100000001);
            const { session } = chatContext;
            recordContextSize(session.metrics, contextIndexOf([2, 0, 1]));
            await sleep(5);
            markRequestStarted(session.metrics);
            async function* stream(): AsyncGenerator<StreamChunk> {
                // Gemini's signature carriers are empty text: not the first chunk
                yield { type: 'text', content: '' };
                await sleep(20);
                yield { type: 'thinking', content: '先想想' };
                yield { type: 'status', status: { text: '🔍 正在搜索…', chatAction: 'typing' } };
                expect(session.statusLine === '🔍 正在搜索…', 'the session carries the tool status line');
                expect(listActiveSessions().includes(session), 'and is listed as active');
                yield { type: 'status' };
                session.metrics.usage.addRound(roundUsage(1200, 60));
                session.metrics.usage.addRound(roundUsage(1300, 40));
                yield { type: 'text', content: '你好呀' };
                yield { type: 'done', agentStats: { toolUsage: [{ name: 'search', count: 2, failed: 1 }, { name: 'fetch', count: 1 }] } };
            }
            await deliver(chatContext, stream());
            const row = await onlyRow(chatContext);
            const { startedAt, requestStartedAt, firstChunkAt, finishedAt } = row;
            expect(
                requestStartedAt !== null &&
                    firstChunkAt !== null &&
                    startedAt.getTime() <= requestStartedAt.getTime() &&
                    firstChunkAt.getTime() - requestStartedAt.getTime() >= 15 &&
                    firstChunkAt.getTime() <= finishedAt.getTime(),
                `startedAt ≤ requestStartedAt < firstChunkAt (the empty chunk skipped) ≤ finishedAt (got ${json({ startedAt, requestStartedAt, firstChunkAt, finishedAt })})`
            );
            expect(
                row.outcome === 'ok' &&
                    row.errorKind === null &&
                    row.versionId === 1 &&
                    !row.isRetry &&
                    row.model === 'deepseek-flash' &&
                    row.platform === 'deepseek' &&
                    row.commandType === 'chat' &&
                    row.route === null &&
                    row.triggerUserId === USER_ID,
                `identity (got ${json(row)})`
            );
            expect(
                row.rounds === 2 && row.promptTokens === 2500 && row.outputTokens === 100 && row.cachedTokens === 0,
                'usage is the sum of the reported rounds'
            );
            expect(row.contextMessages === 3 && row.contextImages === 3, 'context size from the context index');
            expect(row.textChars === 3 && row.thinkingChars === 3, 'text and thinking characters');
            expect(
                row.toolCalls === 3 &&
                    row.toolFailures === 1 &&
                    json(row.toolUsage) === json([{ name: 'search', count: 2, failed: 1 }, { name: 'fetch', count: 1, failed: 0 }]),
                `tool usage (got ${json(row.toolUsage)})`
            );
            expect(!row.hasImage && row.imageCount === 0 && !row.hasSticker && !row.hasFile, 'no attachment');
            expect(
                json(recoveryColumnsOf(row)) === json(NO_RECOVERY_COLUMNS),
                `no retry, no priority, no checkpoint: every new column is NULL (got ${json(recoveryColumnsOf(row))})`
            );
            expect(getActiveSession(chatContext.chatId, session.firstMessageId) === null, 'the session is gone');
        },
    },
    {
        name: 'error: classified after the request, pre_request before it; the ring buffer gets it',
        body: async () => {
            const failed = await startReply(-1005100000002);
            markRequestStarted(failed.session.metrics);
            failed.session.metrics.usage.addRound(roundUsage(900, 0));
            const rateLimited = Object.assign(new Error('429 Resource has been exhausted (e.g. check quota).'), { status: 429 });
            await capture(() => responseHandler.handleResponseError(failed, rateLimited));
            const row = await onlyRow(failed);
            expect(
                row.outcome === 'error' &&
                    row.errorKind === 'rate_limit' &&
                    row.errorSummary === '429 Resource has been exhausted (e.g. check quota).' &&
                    row.rounds === 1 &&
                    row.promptTokens === 900,
                `a 429 is rate_limit and keeps the round it paid for (got ${json(row)})`
            );
            const latest = listRecentReplyErrors()[0];
            expect(
                latest?.chatId === failed.chatId &&
                    latest.errorKind === 'rate_limit' &&
                    latest.firstMessageId === failed.session.firstMessageId &&
                    latest.model === 'deepseek-flash',
                `the in-memory buffer has it first (got ${json(latest)})`
            );

            const early = await startReply(-1005100000003);
            await capture(() => responseHandler.handleResponseError(early, new Error('读取消息失败')));
            const earlyRow = await onlyRow(early);
            expect(
                earlyRow.outcome === 'error' && earlyRow.errorKind === 'pre_request' && earlyRow.requestStartedAt === null && earlyRow.rounds === 0,
                `a failure before sendMessage is pre_request (got ${json(earlyRow)})`
            );
        },
    },
    {
        name: 'classifyErrorKind: status first, then our codes, then the error text',
        body: async () => {
            const withFields = (message: string, fields: Record<string, unknown>): Error =>
                Object.assign(new Error(message), fields);
            const expectations: Array<[string, unknown, string]> = [
                ['status 429', withFields('Too Many Requests', { status: 429 }), 'rate_limit'],
                ['status 503', withFields('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 }), 'upstream'],
                ['status 400 stays out of upstream', withFields('Bad Request: invalid argument', { status: 400 }), 'other'],
                ['MiMo content filter', new AppError('这条被 MiMo 的内容风控拦下了', 'CONTENT_FILTER'), 'content_filter'],
                ["base-platform's attempt timeout", new Error('Timeout'), 'timeout'],
                ['SDK timeout', withFields('Request timed out.', { name: 'APIConnectionTimeoutError' }), 'timeout'],
                ['SDK connection error', withFields('Connection error.', { name: 'APIConnectionError' }), 'network'],
                ['socket code', withFields('read ECONNRESET', { code: 'ECONNRESET' }), 'network'],
                ['undici cause', new Error('fetch failed', { cause: { code: 'ENOTFOUND' } }), 'network'],
                ['429 in a stream error text', new Error('got status: 429 Too Many Requests'), 'rate_limit'],
                ['overloaded in a stream error text', new Error('The model is overloaded. Please try again later.'), 'upstream'],
                ['anything else', new Error('something odd happened'), 'other'],
            ];
            for (const [label, error, kind] of expectations) {
                const actual = classifyErrorKind(error);
                expect(actual === kind, `${label} → ${kind} (got ${actual})`);
            }
            expect(classifyErrorKind(new Error('Timeout'), { beforeRequest: true }) === 'pre_request', 'beforeRequest wins');
            const long = summarizeErrorMessage(`  line one\n\nline two ${'x'.repeat(300)}`);
            expect(Array.from(long).length === 200 && long.startsWith('line one line two') && long.endsWith('…'), 'summaries are one line of ≤ 200 characters');
        },
    },
    {
        name: 'stopped: a stop keeps what the finished rounds cost',
        body: async () => {
            const chatContext = await startReply(-1005100000004);
            const { session } = chatContext;
            markRequestStarted(session.metrics);
            async function* stream(): AsyncGenerator<StreamChunk> {
                session.metrics.usage.addRound(roundUsage(4000, 120));
                yield { type: 'text', content: '第一轮的回答' };
                // The user presses stop while the second round streams
                session.streamController.abort();
                yield { type: 'text', content: '这句不会出现' };
                session.metrics.usage.addRound(roundUsage(9999, 9999));
            }
            await deliver(chatContext, stream());
            const row = await onlyRow(chatContext);
            expect(
                row.outcome === 'stopped' && row.errorKind === null && row.rounds === 1 && row.promptTokens === 4000 && row.outputTokens === 120,
                `stopped, with round 1 only (got ${json(row)})`
            );
        },
    },
    {
        name: 'empty: thinking only, or an image command that drew nothing',
        body: async () => {
            const thinkingOnly = await startReply(-1005100000005);
            markRequestStarted(thinkingOnly.session.metrics);
            async function* onlyThinking(): AsyncGenerator<StreamChunk> {
                yield { type: 'thinking', content: '想了很久' };
                yield { type: 'done' };
            }
            await deliver(thinkingOnly, onlyThinking());
            const thinkingRow = await onlyRow(thinkingOnly);
            expect(thinkingRow.outcome === 'empty' && thinkingRow.thinkingChars === 4, `thinking only is empty (got ${thinkingRow.outcome})`);

            const noPicture = await startReply(-1005100000006, { model: 'gemini-nano-banana-2.1', commandType: 'picbanana' });
            markRequestStarted(noPicture.session.metrics);
            async function* textOnly(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '我画不出来' };
                yield { type: 'done' };
            }
            await deliver(noPicture, textOnly());
            const pictureRow = await onlyRow(noPicture);
            expect(
                pictureRow.outcome === 'empty' && pictureRow.commandType === 'picbanana' && pictureRow.platform === 'gemini',
                `an image command without an image is empty (got ${json(pictureRow)})`
            );
        },
    },
    {
        name: 'versionId and imageCount; a retry is its own row on the next version, observers see no trigger user',
        body: async () => {
            const chatId = -1005100000007;
            const chatContext = await startReply(chatId);
            markRequestStarted(chatContext.session.metrics);
            async function* withPicture(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '给你画好了' };
                yield { type: 'image', imageData: PNG_BYTES, imageMimeType: 'image/png' };
                yield { type: 'done' };
            }
            await deliver(chatContext, withPicture());
            const firstMessageId = chatContext.session.firstMessageId;
            const [first] = await findReplyMetricsByReply(chatId, firstMessageId);
            expect(
                first?.versionId === 1 && first.imageCount === 1 && first.hasImage && first.outcome === 'ok',
                `version 1 with its image (got ${json(first)})`
            );

            const retryUserId = 6160;
            const retryContext = contextOf(
                callbackUpdate({ chatId, messageId: firstMessageId, userId: retryUserId, data: 'resp:retry' }),
                createFakeTelegram()
            );
            const { result: retrySession } = await capture(() => startRetry(retryContext, firstMessageId, { model: 'grok-4.7' }));
            if (!retrySession) throw new Error('no retry session');
            const retryChat = responseHandler.createChatContextForRetry(retryContext, retrySession);
            markRequestStarted(retrySession.metrics);
            async function* retried(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '重新回答' };
                yield { type: 'done' };
            }
            await deliver(retryChat, retried());

            const rows = await findReplyMetricsByReply(chatId, firstMessageId);
            const second = rows[1];
            expect(rows.length === 2, `two attempts, two rows (got ${rows.length})`);
            expect(
                second?.versionId === 2 &&
                    second.isRetry &&
                    second.model === 'grok-4.7' &&
                    second.platform === 'grok' &&
                    second.imageCount === 0 &&
                    second.triggerUserId === retryUserId &&
                    second.userMessageId === first?.userMessageId,
                `the retry row is version 2, its own model, whoever pressed retry (got ${json(second)})`
            );

            const memberView = await listReplyMetricsByReply(chatId, firstMessageId, { access: 'member' });
            const observerView = await listReplyMetricsByReply(chatId, firstMessageId, { access: 'observer' });
            const memberFirst = memberView.get(1)?.[0];
            const observerSecond = observerView.get(2)?.[0];
            expect(
                [...memberView.keys()].join(',') === '1,2' && memberView.get(2)?.length === 1,
                'grouped by version'
            );
            expect(memberFirst !== undefined && 'triggerUserId' in memberFirst, 'members see the trigger user');
            expect(
                observerSecond !== undefined &&
                    !('triggerUserId' in observerSecond) &&
                    !JSON.stringify(observerView.get(1)).includes(String(USER_ID)) &&
                    !JSON.stringify(observerSecond).includes(String(retryUserId)),
                'observers get no trigger user id anywhere'
            );
            expect(
                observerSecond?.pricing === 'no_usage' && observerSecond.costUsd === null && typeof observerSecond.durationMs === 'number',
                `a row without usage is not priced (got ${json(observerSecond)})`
            );
        },
    },
    {
        name: 'a failed metrics write never blocks the finalize',
        body: async () => {
            const chatContext = await startReply(-1005100000008);
            markRequestStarted(chatContext.session.metrics);
            async function* stream(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '照常保存' };
                yield { type: 'done' };
            }
            await sequelize.query('ALTER TABLE reply_metrics RENAME TO reply_metrics_parked');
            let lines: string[] = [];
            try {
                ({ lines } = await capture(async () => {
                    const response = await responseHandler.processStream(stream(), chatContext, 0);
                    await responseHandler.sendFinalResponse(chatContext, response);
                }));
            } finally {
                await sequelize.query('ALTER TABLE reply_metrics_parked RENAME TO reply_metrics');
            }
            const stored = await dbIndex.getBotResponse(chatContext.chatId, chatContext.session.firstMessageId);
            expect(stored?.getVersions()[0]?.text === '照常保存', 'the version is stored');
            expect(getActiveSession(chatContext.chatId, chatContext.session.firstMessageId) === null, 'the session is cleaned up');
            expect(lines.some((line) => line.includes('[reply-metrics] could not record')), 'the failure is logged');
            expect((await rowsOf(chatContext)).length === 0, 'and only the row is missing');
        },
    },
    {
        name: 'recovery and priority: retried attempts, the requested tier and the priority rounds reach the row',
        body: async () => {
            const chatContext = await startReply(-1005100000012, { model: 'gemini-4-argon' });
            const { session } = chatContext;
            const { usage } = session.metrics;
            markRequestStarted(session.metrics);
            async function* stream(): AsyncGenerator<StreamChunk> {
                usage.setTierRequested('priority');
                // Round 1 was downgraded to the standard tier after one failed attempt
                usage.addRecovery();
                usage.addRound({ ...roundUsage(1000, 50), cachedTokens: 600 }, { servedTier: 'standard' });
                // Round 2 was served at the priority tier after two failed attempts
                usage.addRecovery();
                usage.addRecovery();
                usage.addRound({ ...roundUsage(1200, 80), cachedTokens: 900 }, { servedTier: 'priority' });
                // Round 3: priority, without usage (still a round served)
                usage.addRound(null, { servedTier: 'priority' });
                yield { type: 'text', content: '好了' };
                yield { type: 'done' };
            }
            await deliver(chatContext, stream());
            const row = await onlyRow(chatContext);
            expect(
                json(recoveryColumnsOf(row)) ===
                    json({
                        roundRetries: 3,
                        tierRequested: 'priority',
                        priorityRounds: 2,
                        priorityPromptTokens: 1200,
                        priorityCachedTokens: 900,
                        priorityOutputTokens: 80,
                        resumedRounds: null,
                        checkpointRounds: null,
                    }),
                `retries, tier and the priority part (got ${json(recoveryColumnsOf(row))})`
            );
            expect(
                row.rounds === 3 && row.promptTokens === 2200 && row.cachedTokens === 1500 && row.outputTokens === 130,
                `the totals still hold every round (got ${json(row)})`
            );

            const view = (await listReplyMetricsByReply(chatContext.chatId, session.firstMessageId, { access: 'observer' }))
                .get(1)?.[0];
            expect(
                view?.roundRetries === 3 &&
                    view.tierRequested === 'priority' &&
                    view.priorityRounds === 2 &&
                    view.priorityPromptTokens === 1200 &&
                    view.priorityCachedTokens === 900 &&
                    view.priorityOutputTokens === 80 &&
                    view.resumedRounds === null &&
                    view.checkpointRounds === null,
                `the reply detail carries them (got ${json(view)})`
            );
        },
    },
    {
        name: 'recovery and priority: NULL when there was nothing, and kept on a failed attempt',
        body: async () => {
            // Asked for priority, every round downgraded, no retry: only the tier is set
            const downgraded = await startReply(-1005100000013, { model: 'gemini-4-argon' });
            markRequestStarted(downgraded.session.metrics);
            downgraded.session.metrics.usage.setTierRequested('priority');
            downgraded.session.metrics.usage.addRound(roundUsage(500, 20), { servedTier: 'standard' });
            async function* answer(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '标准档' };
                yield { type: 'done' };
            }
            await deliver(downgraded, answer());
            const downgradedRow = await onlyRow(downgraded);
            expect(
                json(recoveryColumnsOf(downgradedRow)) === json({ ...NO_RECOVERY_COLUMNS, tierRequested: 'priority' }),
                `no priority round: the four priority columns are NULL, roundRetries 0 is NULL (got ${json(recoveryColumnsOf(downgradedRow))})`
            );

            // The automatic retries gave up: the failed row still counts them
            const failed = await startReply(-1005100000014, { model: 'gemini-4-argon' });
            markRequestStarted(failed.session.metrics);
            failed.session.metrics.usage.addRecovery();
            failed.session.metrics.usage.addRecovery();
            const rateLimited = Object.assign(new Error('429 Resource has been exhausted'), { status: 429 });
            await capture(() => responseHandler.handleResponseError(failed, rateLimited));
            const failedRow = await onlyRow(failed);
            expect(
                failedRow.outcome === 'error' &&
                    failedRow.roundRetries === 2 &&
                    failedRow.tierRequested === null &&
                    failedRow.priorityRounds === null,
                `the failed row keeps its retries (got ${json(recoveryColumnsOf(failedRow))})`
            );
        },
    },
    {
        name: 'resume facts: the draft carries resumedRounds and checkpointRounds into the row',
        body: async () => {
            const resumed = await startReply(-1005100000015, { model: 'gemini-4-argon' });
            expect(
                resumed.session.metrics.resumedRounds === null && resumed.session.metrics.checkpointRounds === null,
                'a new draft has neither'
            );
            recordResumedRounds(resumed.session.metrics, 4);
            markRequestStarted(resumed.session.metrics);
            async function* answer(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '接着说' };
                yield { type: 'done' };
            }
            await deliver(resumed, answer());
            const resumedRow = await onlyRow(resumed);
            expect(
                resumedRow.resumedRounds === 4 && resumedRow.checkpointRounds === null && resumedRow.outcome === 'ok',
                `a resumed attempt (got ${json(recoveryColumnsOf(resumedRow))})`
            );

            // A resume that failed again and saved a newer checkpoint
            const failedAgain = await startReply(-1005100000016, { model: 'gemini-4-argon' });
            recordResumedRounds(failedAgain.session.metrics, 2);
            markRequestStarted(failedAgain.session.metrics);
            recordCheckpointRounds(failedAgain.session.metrics, 5);
            await capture(() => responseHandler.handleResponseError(failedAgain, new Error('got status: 500 INTERNAL')));
            const failedRow = await onlyRow(failedAgain);
            expect(
                failedRow.outcome === 'error' && failedRow.resumedRounds === 2 && failedRow.checkpointRounds === 5,
                `the failed resume keeps both (got ${json(recoveryColumnsOf(failedRow))})`
            );

            const stopped = await startReply(-1005100000017, { model: 'gemini-4-argon' });
            markRequestStarted(stopped.session.metrics);
            async function* stoppedStream(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '第一轮' };
                recordCheckpointRounds(stopped.session.metrics, 1);
                stopped.session.streamController.abort();
                yield { type: 'text', content: '不会出现' };
            }
            await deliver(stopped, stoppedStream());
            const stoppedRow = await onlyRow(stopped);
            expect(
                stoppedRow.outcome === 'stopped' && stoppedRow.checkpointRounds === 1 && stoppedRow.resumedRounds === null,
                `a stopped attempt with a checkpoint (got ${json(recoveryColumnsOf(stoppedRow))})`
            );
        },
    },
    {
        name: 'the usage aggregate sums the priority part: rounds over every row, tokens over rows with usage',
        body: async () => {
            const chatId = -1005100000018;
            const since = new Date(Date.now() - 3_600_000);
            await insertReplyMetric(
                storedRow(chatId, 9002, {
                    tierRequested: 'priority',
                    rounds: 2,
                    priorityRounds: 1,
                    priorityPromptTokens: 600,
                    priorityCachedTokens: 300,
                    priorityOutputTokens: 40,
                })
            );
            await insertReplyMetric(
                storedRow(chatId, 9004, {
                    tierRequested: 'priority',
                    priorityRounds: 1,
                    priorityPromptTokens: 700,
                    priorityCachedTokens: 0,
                    priorityOutputTokens: 70,
                })
            );
            // A row without usage: its priority round counts, its tokens do not
            await insertReplyMetric(
                storedRow(chatId, 9006, {
                    promptTokens: null,
                    outputTokens: null,
                    cachedTokens: null,
                    tierRequested: 'priority',
                    priorityRounds: 1,
                    priorityPromptTokens: 0,
                    priorityCachedTokens: 0,
                    priorityOutputTokens: 0,
                })
            );
            // Not requested: the columns stay NULL and add nothing
            await insertReplyMetric(storedRow(chatId, 9008, {}));
            // Another model that never asked: its group sums to zeros
            await insertReplyMetric(storedRow(chatId, 9010, { model: 'deepseek-flash', platform: 'deepseek' }));

            const groups = await aggregateUsageByModelRoute({ since, chatId });
            const group = groups.find((entry) => entry.model === 'gemini-4-argon');
            const plainGroup = groups.find((entry) => entry.model === 'deepseek-flash');
            expect(groups.length === 2, `one group per model (got ${groups.length})`);
            expect(
                group?.replies === 4 &&
                    group.repliesWithUsage === 3 &&
                    group.promptTokens === 3000 &&
                    group.priorityRounds === 3 &&
                    group.priorityPromptTokens === 1300 &&
                    group.priorityCachedTokens === 300 &&
                    group.priorityOutputTokens === 110,
                `priority sums next to the totals (got ${json(group)})`
            );

            expect(
                plainGroup !== undefined &&
                    plainGroup.priorityRounds === 0 &&
                    plainGroup.priorityPromptTokens === 0 &&
                    plainGroup.priorityCachedTokens === 0 &&
                    plainGroup.priorityOutputTokens === 0,
                `a group without priority sums to zeros, never null (got ${json(plainGroup)})`
            );

            const detail = await listReplyMetricsByReply(chatId, 9006, { access: 'observer' });
            expect(
                detail.get(1)?.[0]?.priorityRounds === 1 && detail.get(1)?.[0]?.pricing === 'no_usage',
                'the reply detail of the row without usage keeps its priority round'
            );
        },
    },
    {
        name: 'the hourly cleanup never touches reply_metrics, and records its summary for the status page',
        body: async () => {
            const chatId = -1005100000009;
            const longAgo = new Date(Date.now() - 400 * 24 * 3600 * 1000);
            await insertReplyMetric({
                chatId,
                userMessageId: 1,
                firstMessageId: 2,
                versionId: 1,
                triggerUserId: null,
                model: 'gemini-4-argon',
                platform: 'gemini',
                route: null,
                commandType: 'chat',
                isRetry: false,
                startedAt: longAgo,
                requestStartedAt: null,
                firstChunkAt: null,
                finishedAt: longAgo,
                outcome: 'ok',
                errorKind: null,
                errorSummary: null,
                rounds: 1,
                toolCalls: 0,
                toolFailures: 0,
                toolUsage: [],
                promptTokens: 1,
                cachedTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 1,
                thoughtsTokens: 0,
                imageOutputTokens: null,
                contextMessages: 1,
                contextImages: 0,
                textChars: 1,
                thinkingChars: 0,
                hasImage: false,
                imageCount: 0,
                hasSticker: false,
                hasFile: false,
                roundRetries: null,
                tierRequested: null,
                priorityRounds: null,
                priorityPromptTokens: null,
                priorityCachedTokens: null,
                priorityOutputTokens: null,
                resumedRounds: null,
                checkpointRounds: null,
            });
            expect(getLastCleanupRun() === null, 'no cleanup has run yet');
            await capture(() => clearExpiredData());
            expect((await findReplyMetricsByReply(chatId, 2)).length === 1, 'a 400-day-old row survives the cleanup');
            const run = getLastCleanupRun();
            expect(
                run !== null && run.summary.startsWith('Cleared ') && run.elapsedMs >= 0,
                `the cleanup summary is kept in memory (got ${json(run)})`
            );
        },
    },
    {
        name: 'the real chat handler and retry: context size, request time and the MiMo usage chunk reach the rows',
        body: async () => {
            const chatId = -1005100000010;
            const userMessageId = takeMessageId();
            const text = '@AfterSchoolTeatimeBot 你好';
            await dbIndex.saveMessage({ chatId, messageId: userMessageId, userId: USER_ID, date: new Date(), userName: 'u', message: text });
            stubRequests.length = 0;
            const replyContext = contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text }), createFakeTelegram());
            await capture(() => handleReply(replyContext, { mention: true }));

            const firstRequest = stubRequests[0]?.body ?? {};
            expect(
                json(firstRequest.stream_options) === json({ include_usage: true }),
                `the MiMo request asks for the usage chunk (got ${json(firstRequest.stream_options)})`
            );
            const response = await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId } });
            if (!response) throw new Error('the reply was not recorded');
            const [row] = await findReplyMetricsByReply(chatId, response.messageId);
            expect(
                row !== undefined &&
                    row.model === 'mimo-v2.6-flash' &&
                    row.platform === 'mimo' &&
                    row.outcome === 'ok' &&
                    row.requestStartedAt !== null &&
                    row.firstChunkAt !== null &&
                    row.contextMessages === 1 &&
                    row.contextImages === 0,
                `the handler marked the request and the context (got ${json(row)})`
            );
            expect(
                row?.rounds === 1 &&
                    row.promptTokens === 812 &&
                    row.cachedTokens === 512 &&
                    row.outputTokens === 40 &&
                    row.thoughtsTokens === 25 &&
                    row.textChars === '好的，收到'.length,
                `the platform reported the usage chunk (got ${json(row)})`
            );

            const retryContext = contextOf(
                callbackUpdate({ chatId, messageId: response.messageId, userId: USER_ID, data: 'resp:retry' }),
                createFakeTelegram()
            );
            await capture(() => handleRetryRequest(retryContext, response.messageId));
            const rows = await findReplyMetricsByReply(chatId, response.messageId);
            expect(
                rows.length === 2 &&
                    rows[1]?.versionId === 2 &&
                    rows[1].isRetry &&
                    rows[1].contextMessages === 1 &&
                    rows[1].promptTokens === 812 &&
                    rows[1].requestStartedAt !== null,
                `the retry handler wires the same (got ${json(rows[1])})`
            );
        },
    },
    {
        name: 'the real /picgpt handler: reference images as the context, the images API usage as the round',
        body: async () => {
            const chatId = -1005100000011;
            const ctx = contextOf(
                messageUpdate({ chatId, messageId: takeMessageId(), userId: USER_ID, text: '/picgpt 一只猫' }),
                createFakeTelegram()
            );
            await capture(() => handlePicgptCommand(ctx, { prompt: '一只猫', referenceImages: [PNG_BASE64] }));
            const message = ctx.message;
            if (!message) throw new Error('no message');
            const response = await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId: message.message_id } });
            if (!response) throw new Error('the /picgpt reply was not recorded');
            const [row] = await findReplyMetricsByReply(chatId, response.messageId);
            expect(
                row !== undefined &&
                    row.model === OPENAI_IMAGE_MODEL &&
                    row.platform === 'openai' &&
                    row.commandType === 'picgpt' &&
                    row.outcome === 'ok' &&
                    row.imageCount === 1 &&
                    row.contextMessages === null &&
                    row.contextImages === 1,
                `an image command row (got ${json(row)})`
            );
            expect(
                row?.rounds === 1 && row.promptTokens === 31 && row.outputTokens === 1056 && row.imageOutputTokens === 1056,
                `the images API usage, all output as image output (got ${json(row)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
modelStub.close();
reportResults(results);
