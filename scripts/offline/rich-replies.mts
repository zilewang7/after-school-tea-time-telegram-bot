/**
 * Offline cases for rich-message delivery of the reply body (scout rich-send
 * §7.2). With the chat's richReplies switch on, the body streams and ends as
 * one Telegram rich message; off (the default) every call stays as it was.
 *
 * The cases drive the real `processStream` / `sendFinalResponse` /
 * `handleResponseError` against the fake Telegram API and a scratch database.
 *
 * Case 1 is the guard of the default path: the full call log of a few replies
 * with the switch off is compared, call by call, with the log the code made
 * before rich delivery existed (fixtures/rich-guard-calls.json). Only when the
 * default path changes on purpose is the fixture recorded again:
 * RICH_GUARD_RECORD=1 npx tsx scripts/offline/rich-replies.mts
 *
 * Run: pnpm test:offline rich-replies
 */
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_TOKEN = '123456:test-bot-token';
process.env.BOT_USER_ID = '7777';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
delete process.env.SEARCH_LINK;
delete process.env.THINKING_LINK;

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InputFile } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
    waitUntil,
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';
import type { GroundingData, StreamChunk } from '../../src/ai/types.js';

type ChatContext = import('../../src/reply/response-handler.js').ChatContext;

await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const { markPendingEditWhileProcessing } = await import('../../src/state.js');

const USER_ID = 603421700;
/** The reply's model; nothing here depends on which one */
const MODEL = 'gemini-4-argon';
const GUARD_FIXTURE = fileURLToPath(new URL('./fixtures/rich-guard-calls.json', import.meta.url));

/** A PNG's first bytes: enough for the mime sniff the image delivery does */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One chat per reply: the edit coordinator paces calls per chat */
let nextChatId = -1009977000000;
const nextChat = (): number => (nextChatId -= 1);

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

const textChunk = (content: string): StreamChunk => ({ type: 'text', content });
const thinkingChunk = (content: string): StreamChunk => ({ type: 'thinking', content });

/** One step of a scripted stream */
interface StreamStep {
    readonly chunk: StreamChunk;
    /** Whether the chunk makes a Telegram call (a frame); default true */
    readonly frame?: boolean;
    /** Runs right before the chunk is handed over (a stop click) */
    readonly before?: () => void;
}

/** A failure the stream throws after its steps */
interface FailingStream {
    readonly steps: readonly StreamStep[];
    readonly failure?: Error;
}

/**
 * A stream that hands over one chunk at a time and, for a chunk that makes a
 * frame, waits until the call has reached the fake API. No frame is then
 * coalesced with the next one, so the call log is the same on every run.
 */
const steppedStream = (telegram: FakeTelegram, script: FailingStream): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
        for (const step of script.steps) {
            // The update throttle compares whole milliseconds since the last frame
            await sleep(2);
            step.before?.();
            const before = telegram.calls.length;
            yield step.chunk;
            if (step.frame === false) {
                await sleep(20);
                continue;
            }
            await waitUntil('the frame of a chunk', () => telegram.calls.length > before);
        }
        if (script.failure !== undefined) throw script.failure;
    },
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

interface StartedReply {
    readonly telegram: FakeTelegram;
    readonly chatContext: ChatContext;
    readonly chatId: number;
    readonly userMessageId: number;
    readonly firstMessageId: number;
}

const startReply = async (telegram: FakeTelegram = createFakeTelegram()): Promise<StartedReply> => {
    const chatId = nextChat();
    const userMessageId = takeMessageId();
    const ctx = contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text: '问个问题' }), telegram);
    const chatContext = await quietly(() => responseHandler.createChatContext(ctx, { model: MODEL }));
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);
    return { telegram, chatContext, chatId, userMessageId, firstMessageId: chatContext.session.firstMessageId };
};

/** Stream the script, then deliver the final as the chat handler does (the error path on a throw) */
const runReply = async (started: StartedReply, script: FailingStream): Promise<void> => {
    const { chatContext, telegram } = started;
    await quietly(async () => {
        try {
            const response = await responseHandler.processStream(steppedStream(telegram, script), chatContext, 0);
            await responseHandler.sendFinalResponse(chatContext, response);
        } catch (error) {
            await responseHandler.handleResponseError(chatContext, error instanceof Error ? error : new Error(String(error)));
        }
    });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One anchor per query, so every query becomes a text_link */
const queryAnchors = (queries: readonly string[]): string =>
    queries.map((query, index) => `<a href="https://www.google.com/search?q=query-${index + 1}">${query}</a>`).join('\n');

/** 131 linked queries: the footer cannot fit one message and folds into the page link */
const bigFooter = (): GroundingData => {
    const queries = Array.from({ length: 131 }, (_, index) => `事故查询 ${index + 1}`);
    return {
        searchQueries: queries,
        searchEntryPoint: { renderedContent: queryAnchors(queries) },
        groundingChunks: ['来源甲', '来源乙', '来源丙'].map((title, index) => ({
            web: { uri: `https://example.test/source-${index + 1}`, title },
        })),
    };
};

/** An answer that uses what differs between the two dialects */
const DIALECT_ANSWER = [
    '## 结论\n\n',
    '的**"重点"**后，__下划线__，||剧透||，`a < b` 和 List<String>。\n\n',
    '| 方案 | 价格 |\n|---|---|\n| A | $5 |\n\n公式 $E = mc^2$，第一行\n第二行\n\n```ts\nconst x = a ** b;\n```',
];

/** About 9,000 characters in paragraphs: the stream splits it into continuations */
const longAnswerChunks = (): string[] =>
    Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 段：${'内容很长。'.repeat(190)}\n\n`);

// ---------------------------------------------------------------------------
// The call log, normalized
// ---------------------------------------------------------------------------

interface CallShape {
    readonly method: string;
    /** Every own key of the payload, undefined values included */
    readonly keys: readonly string[];
    /** The payload as it goes over the wire, with ids replaced by their order of appearance */
    readonly payload: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** Above this a string is kept as its hash: the long replies would make the fixture huge */
const LONG_STRING = 300;

const compactString = (value: string): string => {
    const hidden = value.replace(/\/g\/[\w.~-]+/g, '/g/<token>');
    if (hidden.length <= LONG_STRING) return hidden;
    const digest = createHash('sha256').update(hidden).digest('hex').slice(0, 16);
    return `<${hidden.length} chars sha256:${digest} ${hidden.slice(0, 40)}…${hidden.slice(-20)}>`;
};

/** Ids and signed page tokens differ between runs; everything else is compared as sent */
const normalizeCalls = (calls: readonly TelegramCall[]): CallShape[] => {
    const messageIds = new Map<number, string>();
    const messageToken = (id: number): string => {
        const known = messageIds.get(id);
        if (known !== undefined) return known;
        const token = `<message ${messageIds.size + 1}>`;
        messageIds.set(id, token);
        return token;
    };
    const normalize = (value: unknown, key: string): unknown => {
        if (typeof value === 'number' && key === 'chat_id') return '<chat>';
        if (typeof value === 'number' && key === 'message_id') return messageToken(value);
        if (typeof value === 'string') return compactString(value);
        if (value instanceof InputFile) return '<input file>';
        if (Array.isArray(value)) return value.map((item) => normalize(item, key));
        if (typeof value === 'object' && value !== null) {
            return Object.fromEntries(
                Object.entries(value)
                    .filter(([, field]) => field !== undefined)
                    .map(([field, fieldValue]) => [field, normalize(fieldValue, field)])
            );
        }
        return value;
    };
    return calls.map((call) => ({
        method: call.method,
        keys: Object.keys(call.payload),
        payload: normalize(call.payload, ''),
    }));
};

const json = (value: unknown): string => JSON.stringify(value);

interface GuardScenario {
    readonly name: string;
    readonly script: (started: StartedReply) => FailingStream;
    /** A user edit while the reply runs: the reply ends with the retry button */
    readonly pendingEdit?: boolean;
    /** 重试 once the reply is done: the new version streams into the same message */
    readonly retry?: FailingStream;
}

/** The replies of the guard: every branch of the default path a rich reply also takes */
const GUARD_SCENARIOS: readonly GuardScenario[] = [
    {
        name: 'thinking, then a dialect-heavy answer',
        pendingEdit: true,
        script: () => ({
            steps: [
                { chunk: thinkingChunk('**计划**\n\n先想一想。') },
                { chunk: thinkingChunk('\n\n再想一想 #1。') },
                ...DIALECT_ANSWER.map((content): StreamStep => ({ chunk: textChunk(content) })),
                {
                    chunk: { type: 'done', agentStats: { toolUsage: [{ name: 'web_search', count: 2 }] } },
                    frame: false,
                },
            ],
        }),
    },
    {
        name: 'a short answer with an image',
        script: () => ({
            steps: [
                { chunk: textChunk('图来了，') },
                { chunk: textChunk('请看下面。') },
                { chunk: { type: 'image', imageData: PNG_BYTES, imageCaption: '一张图' }, frame: false },
            ],
        }),
    },
    {
        name: 'an error after a partial answer',
        script: () => ({
            steps: [{ chunk: thinkingChunk('想到一半') }, { chunk: textChunk('答到一半，') }, { chunk: textChunk('```ts\nconst a') }],
            failure: new Error('got status: 500 Internal Server Error'),
        }),
    },
    {
        name: 'a stop after a partial answer',
        script: (started) => ({
            steps: [
                { chunk: textChunk('说到一半') },
                { chunk: textChunk('，还没说完') },
                // The stop click lands before this chunk: the stream ends without it
                {
                    chunk: textChunk('不会显示'),
                    frame: false,
                    before: () => started.chatContext.session.streamController.abort(),
                },
            ],
        }),
    },
    {
        name: 'a long answer that splits, with an image',
        pendingEdit: true,
        script: () => ({
            steps: [
                ...longAnswerChunks().map((content): StreamStep => ({ chunk: textChunk(content) })),
                // The split chunk opened the last continuation without a frame of
                // its own: this chunk shows the text that moved there
                { chunk: { type: 'image', imageData: PNG_BYTES } },
            ],
        }),
    },
    {
        name: 'an answer whose search footer folds',
        script: () => ({
            steps: [
                { chunk: textChunk('搜到了：答案。') },
                { chunk: { type: 'grounding', groundingMetadata: bigFooter() }, frame: false },
            ],
        }),
    },
    {
        name: 'an answer, then its retry',
        script: () => ({ steps: [{ chunk: textChunk('第一版。') }] }),
        retry: { steps: [{ chunk: thinkingChunk('重新想') }, { chunk: textChunk('第二版，') }, { chunk: textChunk('更好。') }] },
    },
];

/** 重试 on a finished reply: a new session on its first message, streamed and delivered */
const runRetry = async (started: StartedReply, script: FailingStream): Promise<void> => {
    const session = await quietly(() =>
        botMessageService.startRetry(started.chatContext.ctx, started.firstMessageId, { model: MODEL })
    );
    if (session === null) throw new Error('offline: the retry session did not start');
    const chatContext = trackReply(responseHandler.createChatContextForRetry(started.chatContext.ctx, session));
    await runReply({ ...started, chatContext }, script);
};

/** Run one guard reply with the switch off and return its call log */
const guardCallsOf = async (scenario: GuardScenario): Promise<CallShape[]> => {
    const started = await startReply();
    if (scenario.pendingEdit === true) markPendingEditWhileProcessing(started.chatId, started.userMessageId);
    await runReply(started, scenario.script(started));
    if (scenario.retry !== undefined) await runRetry(started, scenario.retry);
    return normalizeCalls(started.telegram.calls);
};

const results: CaseResult[] = [];

results.push(
    await runCase('case 1: with the switch off every call of a reply is the call the code made before rich delivery', async () => {
        const recorded: Record<string, CallShape[]> = {};
        for (const scenario of GUARD_SCENARIOS) {
            recorded[scenario.name] = await guardCallsOf(scenario);
        }
        if (process.env.RICH_GUARD_RECORD === '1') {
            writeFileSync(GUARD_FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
            console.log(`[offline] recorded ${GUARD_SCENARIOS.length} replies into ${GUARD_FIXTURE}`);
            return;
        }
        const expected = asRecord(JSON.parse(readFileSync(GUARD_FIXTURE, 'utf8')));
        for (const scenario of GUARD_SCENARIOS) {
            const actualCalls = recorded[scenario.name] ?? [];
            const stored = expected[scenario.name];
            const expectedCalls: unknown[] = Array.isArray(stored) ? stored : [];
            const firstDifference = Array.from(
                { length: Math.max(actualCalls.length, expectedCalls.length) },
                (_, index) => index
            ).find((index) => json(actualCalls[index]) !== json(expectedCalls[index]));
            expect(
                firstDifference === undefined,
                `${scenario.name}: call ${String(firstDifference)} differs\n  expected ${json(
                    expectedCalls[firstDifference ?? 0]
                )}\n  actual   ${json(actualCalls[firstDifference ?? 0])}`
            );
            expect(
                actualCalls.every((call) => call.method !== 'sendRichMessage' && !call.keys.includes('rich_message')),
                `${scenario.name}: no rich call at all`
            );
        }
    })
);

endOpenReplies();
reportResults(results);
