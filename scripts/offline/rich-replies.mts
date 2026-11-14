/**
 * Offline cases for rich-message delivery of the reply body (scout rich-send
 * §7.2). With the chat's richReplies switch on, the body streams and ends as
 * one Telegram rich message; off (the default) every call stays as it was.
 *
 * Most cases drive the real `processStream` / `sendFinalResponse` /
 * `handleResponseError` against the fake Telegram API and a scratch database.
 * The retry and continue cases go through the real handlers on the resume
 * bench (support/resume-bench.mts), which also gives a kept checkpoint.
 *
 * Case 1 guards the default path, for the replies of GUARD_SCENARIOS only: with
 * the switch off, the full call log of each is compared, call by call, with
 * the log the code made before rich delivery existed
 * (fixtures/rich-guard-calls.json, recorded on a4beb40, the commit before the
 * delivery code). Only when the default path changes on purpose is the
 * fixture recorded again, on the code of that change:
 * RICH_GUARD_RECORD=1 npx tsx scripts/offline/rich-replies.mts
 *
 * Run: pnpm test:offline rich-replies
 */
process.env.BOT_TOKEN = '123456:test-bot-token';
delete process.env.SEARCH_LINK;

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GrammyError, InputFile } from 'grammy';
import { renderMarkdown } from 'telegram-md-entities';
import { expect, reportResults, runCase, takeMessageId, type CaseResult } from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
    waitUntil,
    type FakeTelegram,
    type FakeTelegramOptions,
    type TelegramCall,
} from './fake-telegram.mts';
import { answer } from './support/gemini-loop-fixtures.mts';
import {
    createResumeBench,
    FULL_USER_ID,
    keyboardLabels,
    OWNER_USER_ID,
    quietCase,
    stalledRound,
    takeChatId,
    webLookup,
} from './support/resume-bench.mts';
import type { GroundingData, StreamChunk } from '../../src/ai/types.js';
import type { CommandType } from '../../src/db/botResponseDTO.js';

type ChatContext = import('../../src/reply/response-handler.js').ChatContext;

// The bench sets the env (public URL, bot name, tool chats) and prepares the
// scratch database before anything from src is imported
const bench = await createResumeBench();
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const dbIndex = await import('../../src/db/index.js');
const { markPendingEditWhileProcessing } = await import('../../src/state.js');
const { updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const checks = await import('../../src/reply/resume/continue-checks.js');
const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');
const { SEARCH_LINK_LABEL } = await import('../../src/telegram/formatters/google-search-link.js');
const { RICH_MAX_SOURCE_LENGTH } = await import('../../src/reply/rich-delivery.js');

const USER_ID = 603421700;
const OWNER = { userId: OWNER_USER_ID, isOwner: true };
/** The reply's model; nothing here depends on which one */
const MODEL = 'gemini-4-argon';
const GUARD_FIXTURE = fileURLToPath(new URL('./fixtures/rich-guard-calls.json', import.meta.url));

/** A PNG's first bytes: enough for the mime sniff the image delivery does */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

/** The italic status paragraph a streaming rich frame ends with */
const RICH_STATUS_LINE = /\n\n<p><i>[^<]+<\/i><\/p>$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One chat per reply: the edit coordinator paces calls per chat */
let nextChatId = -1009977000000;
const nextChat = (): number => (nextChatId -= 1);

const json = (value: unknown): string => JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

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

const textSteps = (texts: readonly string[]): StreamStep[] => texts.map((content) => ({ chunk: textChunk(content) }));

const thinkingSteps = (thinking: string, chunkSize = 500): StreamStep[] => {
    const steps: StreamStep[] = [];
    for (let index = 0; index < thinking.length; index += chunkSize) {
        steps.push({ chunk: thinkingChunk(thinking.slice(index, index + chunkSize)) });
    }
    return steps;
};

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

interface ReplyOptions {
    /** The switch as the reply's settings snapshot has it */
    readonly richReplies: boolean;
    readonly commandType?: CommandType;
    /** Telegram refusals for this reply's calls */
    readonly refuse?: FakeTelegramOptions['refuse'];
}

const startReply = async (options: ReplyOptions): Promise<StartedReply> => {
    const telegram = createFakeTelegram(options.refuse === undefined ? {} : { refuse: options.refuse });
    const chatId = nextChat();
    const userMessageId = takeMessageId();
    const ctx = contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text: '问个问题' }), telegram);
    const chatContext = await quietly(() =>
        responseHandler.createChatContext(ctx, {
            model: MODEL,
            richReplies: options.richReplies,
            ...(options.commandType === undefined ? {} : { commandType: options.commandType }),
        })
    );
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);
    return { telegram, chatContext, chatId, userMessageId, firstMessageId: chatContext.session.firstMessageId };
};

/** Run `body` with the console captured; returns what it logged */
const withLogs = async (body: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        await body();
    } catch (error) {
        original.error(lines.slice(-30).join('\n'));
        throw error;
    } finally {
        Object.assign(console, original);
    }
    return lines;
};

/**
 * Stream the script, then deliver the final as the chat handler does (the
 * error path on a throw). Returns what the reply logged.
 */
const runReply = (
    started: StartedReply,
    script: FailingStream,
    options: { readonly beforeFinal?: () => void } = {}
): Promise<string[]> =>
    withLogs(async () => {
        const { chatContext, telegram } = started;
        try {
            const response = await responseHandler.processStream(steppedStream(telegram, script), chatContext, 0);
            options.beforeFinal?.();
            await responseHandler.sendFinalResponse(chatContext, response);
        } catch (error) {
            await responseHandler.handleResponseError(chatContext, error instanceof Error ? error : new Error(String(error)));
        }
    });

/** 重试 on a finished reply: a new session on its first message, streamed and delivered */
const runRetry = async (started: StartedReply, script: FailingStream): Promise<void> => {
    const session = await quietly(() =>
        botMessageService.startRetry(started.chatContext.ctx, started.firstMessageId, { model: MODEL })
    );
    if (session === null) throw new Error('offline: the retry session did not start');
    const chatContext = trackReply(responseHandler.createChatContextForRetry(started.chatContext.ctx, session));
    await runReply({ ...started, chatContext }, script);
};

const versionsOf = async (started: { readonly chatId: number; readonly firstMessageId: number }) =>
    (await dbIndex.getBotResponse(started.chatId, started.firstMessageId))?.getVersions() ?? [];

// ---------------------------------------------------------------------------
// Reading the calls
// ---------------------------------------------------------------------------

/** The markdown of a rich edit or send; undefined for any other call */
const richMarkdownOf = (call: TelegramCall | undefined): string | undefined => {
    const markdown = asRecord(call?.payload.rich_message).markdown;
    return typeof markdown === 'string' ? markdown : undefined;
};

const isRichCall = (call: TelegramCall): boolean =>
    call.method === 'sendRichMessage' || call.payload.rich_message !== undefined;

const editsOf = (telegram: FakeTelegram, messageId?: number): TelegramCall[] =>
    telegram
        .callsOf('editMessageText')
        .filter((call) => messageId === undefined || call.payload.message_id === messageId);

const labelsOf = (call: TelegramCall | undefined): string[] => keyboardLabels(call?.payload.reply_markup) ?? [];

const textOf = (call: TelegramCall | undefined): string =>
    typeof call?.payload.text === 'string' ? call.payload.text : '';

const fallbacksIn = (lines: readonly string[]): string[] =>
    lines.filter((line) => line.startsWith('[rich] fallback to entities'));

const deliveredIn = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[rich] delivered'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One anchor per query, so every query becomes a text_link */
const queryAnchors = (queries: readonly string[]): string =>
    queries.map((query, index) => `<a href="https://www.google.com/search?q=query-${index + 1}">${query}</a>`).join('\n');

const searchFooter = (queries: readonly string[], sourceTitles: readonly string[]): GroundingData => ({
    searchQueries: [...queries],
    searchEntryPoint: { renderedContent: queryAnchors(queries) },
    groundingChunks: sourceTitles.map((title, index) => ({
        web: { uri: `https://example.test/source-${index + 1}`, title },
    })),
});

/** 131 linked queries: the footer cannot fit one message and folds into the page link */
const bigFooter = (): GroundingData =>
    searchFooter(
        Array.from({ length: 131 }, (_, index) => `事故查询 ${index + 1}`),
        ['来源甲', '来源乙', '来源丙']
    );

/** A footer that fits one message */
const smallFooter = (): GroundingData => searchFooter(['小查询 1', '小查询 2'], ['小来源']);

/** An answer that uses what differs between the two dialects */
const DIALECT_ANSWER = [
    '## 结论\n\n',
    '的**"重点"**后，__下划线__，||剧透||，`a < b` 和 List<String>。\n\n',
    '| 方案 | 价格 |\n|---|---|\n| A | $5 |\n\n公式 $E = mc^2$，第一行\n第二行\n\n```ts\nconst x = a ** b;\n```',
];

/** About 9,000 characters in paragraphs: the stream splits it into continuations */
const longAnswerChunks = (): string[] =>
    Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 段：${'内容很长。'.repeat(190)}\n\n`);

/** Six ~700-character sections: past one message, so the stream activates the CoT link */
const longThinking = (): string =>
    Array.from({ length: 6 }, (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`).join('\n\n');

// ---------------------------------------------------------------------------
// The call log, normalized (case 1)
// ---------------------------------------------------------------------------

interface CallShape {
    readonly method: string;
    /** Every own key of the payload, undefined values included */
    readonly keys: readonly string[];
    /** The payload as it goes over the wire, with ids replaced by their order of appearance */
    readonly payload: unknown;
}

/** Above this a string is kept as its hash: the long replies would make the fixture huge */
const LONG_STRING = 300;

/**
 * The page tokens in links differ between runs: the signed search page token
 * (/g/), the random thinking token of the fast page (/t/) and of the Mini App
 * route (/think/), and the Mini App direct links (startapp=<kind letter><token>,
 * the kind stays visible).
 */
const RUN_DEPENDENT_TOKENS: readonly (readonly [RegExp, string])[] = [
    [/\/(g|t|think)\/[\w.~-]+/g, '/$1/<token>'],
    [/startapp=([a-z])[\w-]+/g, 'startapp=$1<token>'],
];

const compactString = (value: string): string => {
    const hidden = RUN_DEPENDENT_TOKENS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), value);
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

interface GuardScenario {
    readonly name: string;
    readonly script: (started: StartedReply) => FailingStream;
    /** A user edit while the reply runs: the reply ends with the retry button */
    readonly pendingEdit?: boolean;
    /** 重试 once the reply is done: the new version streams into the same message */
    readonly retry?: FailingStream;
}

/**
 * The replies of the guard, each run through the real stream and final
 * delivery (or the error path) with the switch off. Together they cover:
 * - streaming: thinking then answer, the split into continuations, link mode
 *   (the pending link with its card, the link going out), tool status lines
 *   (the refresh of an empty message, the line under thinking and answer);
 * - the final: inline thinking, a stop, a user edit's button, a link emitted
 *   while streaming, a link the final creates, a stop with the link pending,
 *   a folded search footer, an image after text, an image alone, a retry;
 * - the error display: inline thinking, a pending link.
 * Not covered: the timed status refreshes (spinner, a cleared line's linger;
 * a refresh under content coalesces with the content edit, so only these
 * would show it), an empty reply, errors with a kept checkpoint, 继续,
 * /picbanana and /picgpt, refused or failed Telegram calls, stickers, files,
 * widgets.
 */
const GUARD_SCENARIOS: readonly GuardScenario[] = [
    {
        name: 'thinking, then a dialect-heavy answer',
        pendingEdit: true,
        script: () => ({
            steps: [
                { chunk: thinkingChunk('**计划**\n\n先想一想。') },
                { chunk: thinkingChunk('\n\n再想一想 #1。') },
                ...textSteps(DIALECT_ANSWER),
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
                ...textSteps(['图来了，', '请看下面。']),
                { chunk: { type: 'image', imageData: PNG_BYTES, imageCaption: '一张图' }, frame: false },
            ],
        }),
    },
    {
        name: 'an error after a partial answer',
        script: () => ({
            steps: [{ chunk: thinkingChunk('想到一半') }, ...textSteps(['答到一半，', '```ts\nconst a'])],
            failure: new Error('got status: 500 Internal Server Error'),
        }),
    },
    {
        name: 'a stop after a partial answer',
        script: (started) => ({
            steps: [
                ...textSteps(['说到一半', '，还没说完']),
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
                ...textSteps(longAnswerChunks()),
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
        retry: { steps: [{ chunk: thinkingChunk('重新想') }, ...textSteps(['第二版，', '更好。'])] },
    },
    {
        name: 'link mode: the link goes out while streaming, the answer follows',
        script: () => ({ steps: [...thinkingSteps(longThinking()), ...textSteps(['答案来了。', '第二句。'])] }),
    },
    {
        name: 'link mode: an error while the link is still pending',
        script: () => ({
            steps: thinkingSteps(longThinking()),
            failure: new Error('got status: 500 Internal Server Error'),
        }),
    },
    {
        name: 'link mode: a stop while the link is still pending',
        script: (started) => ({
            steps: [
                ...thinkingSteps(longThinking()),
                {
                    chunk: thinkingChunk('不会显示'),
                    frame: false,
                    before: () => started.chatContext.session.streamController.abort(),
                },
            ],
        }),
    },
    {
        name: 'the answer first, then a long thinking: the final creates the link',
        script: () => ({ steps: [...textSteps(['答案。']), ...thinkingSteps(longThinking())] }),
    },
    {
        name: 'tool status lines before and while the answer streams',
        script: () => ({
            steps: [
                // The editor's own refresh while the message is empty; later the
                // line rides on the content edits, which its refresh coalesces into
                { chunk: { type: 'status', status: { text: '🔍 正在搜索…', chatAction: 'typing' } } },
                { chunk: thinkingChunk('先查一下资料。') },
                { chunk: { type: 'status', status: { text: '📖 正在读网页…', chatAction: 'typing' } } },
                { chunk: textChunk('先说一句，') },
                // The line lingers after the tool ends: clearing it alone makes no call
                { chunk: { type: 'status' }, frame: false },
                { chunk: textChunk('再说一句。') },
                { chunk: { type: 'status', status: { text: '🖼 正在画图…', chatAction: 'typing' } } },
                { chunk: textChunk('画好了。') },
            ],
        }),
    },
    {
        name: 'an image and no text',
        script: () => ({ steps: [{ chunk: { type: 'image', imageData: PNG_BYTES }, frame: false }] }),
    },
];

/** Run one guard reply with the switch off, as the handlers pass it, and return its call log */
const guardCallsOf = async (scenario: GuardScenario): Promise<CallShape[]> => {
    const started = await startReply({ richReplies: false });
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
                firstDifference === undefined
                    ? `${scenario.name}: all ${actualCalls.length} calls as before`
                    : `${scenario.name}: call ${firstDifference} differs\n  expected ${json(
                          expectedCalls[firstDifference]
                      )}\n  actual   ${json(actualCalls[firstDifference])}`
            );
            expect(
                actualCalls.every((call) => call.method !== 'sendRichMessage' && !call.keys.includes('rich_message')),
                `${scenario.name}: no rich call at all`
            );
        }
    })
);

// ---------------------------------------------------------------------------
// Switch on
// ---------------------------------------------------------------------------

results.push(
    await runCase('case 2: a short reply streams rich frames with the stop button and ends as one rich message', async () => {
        const started = await startReply({ richReplies: true });
        markPendingEditWhileProcessing(started.chatId, started.userMessageId);
        const logs = await runReply(started, {
            steps: [
                { chunk: thinkingChunk('**计划**\n\n先想一想。') },
                { chunk: thinkingChunk('\n\n再想一想。') },
                ...textSteps(DIALECT_ANSWER),
                {
                    chunk: { type: 'done', agentStats: { toolUsage: [{ name: 'web_search', count: 2 }] } },
                    frame: false,
                },
            ],
        });
        const { telegram } = started;
        const edits = editsOf(telegram, started.firstMessageId);
        expect(edits.length >= 6, `the frames and the final went to the reply's message (got ${edits.length})`);
        expect(
            edits.every((call) => richMarkdownOf(call) !== undefined && call.payload.text === undefined),
            'every edit carries rich_message.markdown and no text'
        );
        expect(
            edits.every((call) => call.payload.entities === undefined && call.payload.link_preview_options === undefined),
            'and neither entities nor a link preview'
        );
        const frames = edits.slice(0, -1);
        const final = edits.at(-1);
        expect(
            frames.every((call) => json(labelsOf(call)) === json(['停止'])),
            `the stop button rides on every streaming frame (got ${json(frames.map(labelsOf))})`
        );
        expect(
            RICH_STATUS_LINE.test(richMarkdownOf(frames.at(-1)) ?? ''),
            `the last frame ends with the italic status paragraph (got ${json(richMarkdownOf(frames.at(-1))?.slice(-60))})`
        );
        expect(
            richMarkdownOf(frames[0])?.startsWith('<blockquote>') === true,
            `while the model thinks, the thinking shows as a quote (got ${json(richMarkdownOf(frames[0])?.slice(0, 40))})`
        );

        const finalMarkdown = richMarkdownOf(final) ?? '';
        expect(!RICH_STATUS_LINE.test(finalMarkdown) && !finalMarkdown.includes('Thinking...'), 'the final has no status line');
        expect(finalMarkdown.startsWith('<blockquote expandable>'), `the thinking is an expandable quote (got ${json(finalMarkdown.slice(0, 40))})`);
        for (const piece of ['## 结论', '<b>"重点"</b>', '<u>下划线</u>', '<tg-spoiler>剧透</tg-spoiler>', 'List&lt;String>', '| 方案 | 价格 |', '$E = mc^2$', '```ts']) {
            expect(finalMarkdown.includes(piece), `the final carries ${piece}`);
        }
        expect(finalMarkdown.includes('Tools'), 'and the tool record section');
        expect(final?.payload.reply_markup === undefined, 'the final edit itself carries no buttons');

        const buttons = telegram.callsOf('editMessageReplyMarkup');
        expect(
            buttons.length === 1 &&
                buttons[0]?.payload.message_id === started.firstMessageId &&
                json(labelsOf(buttons[0])) === json(['检测到用户编辑，是否重试']),
            `the final buttons come through editMessageReplyMarkup (got ${json(buttons.map((call) => call.payload))})`
        );

        const versions = await versionsOf(started);
        expect(versions.length === 1, `one version (got ${versions.length})`);
        expect(versions[0]?.text === DIALECT_ANSWER.join(''), 'the stored text is the raw model text, __下划线__ unchanged');
        expect(versions[0]?.thinkingLinkToken === undefined, 'no thinking link');
        expect(
            deliveredIn(logs).length === 1 &&
                deliveredIn(logs)[0] ===
                    `[rich] delivered chat=${started.chatId} first=${started.firstMessageId} chars=${finalMarkdown.length} link=false searchLink=false`,
            `one success line (got ${json(deliveredIn(logs))})`
        );
        expect(fallbacksIn(logs).length === 0, 'no fallback');
    })
);

/**
 * Whether `needle` shows inside a code block of the document, read by the
 * package's CommonMark parser (the referee the delivery itself uses)
 */
const landsInCode = (markdown: string, needle: string): boolean => {
    const rendered = renderMarkdown(markdown);
    const at = rendered.text.lastIndexOf(needle);
    return (
        at === -1 ||
        rendered.entities.some(
            (entity) => (entity.type === 'pre' || entity.type === 'code') && entity.offset <= at && at < entity.offset + entity.length
        )
    );
};

results.push(
    await runCase('case 3: a fence open mid-stream is closed before the status line', async () => {
        const started = await startReply({ richReplies: true });
        await runReply(started, { steps: textSteps(['代码如下：\n\n```ts\nconst a = 1;', '\n```\n\n结束。']) });
        const [openFrame] = editsOf(started.telegram, started.firstMessageId);
        const markdown = richMarkdownOf(openFrame) ?? '';
        expect(
            markdown.includes('```ts\nconst a = 1;\n```\n\n<p><i>') && RICH_STATUS_LINE.test(markdown),
            `the fence closes, then the status paragraph follows (got ${json(markdown)})`
        );
        const final = richMarkdownOf(editsOf(started.telegram, started.firstMessageId).at(-1));
        expect(final === '代码如下：\n\n```ts\nconst a = 1;\n```\n\n结束。', `the final is the whole answer (got ${json(final)})`);
    })
);

results.push(
    await runCase('case 3: a fence open inside a list item keeps the status line and [stopped] outside the code', async () => {
        const started = await startReply({ richReplies: true });
        await runReply(started, {
            steps: [
                ...textSteps(['步骤：\n\n1. 安装：\n   ```bash\n   npm i']),
                {
                    chunk: textChunk('不会显示'),
                    frame: false,
                    before: () => started.chatContext.session.streamController.abort(),
                },
            ],
        });
        const [frame] = editsOf(started.telegram, started.firstMessageId);
        const frameMarkdown = richMarkdownOf(frame) ?? '';
        expect(RICH_STATUS_LINE.test(frameMarkdown), 'the frame ends with the status paragraph');
        expect(!landsInCode(frameMarkdown, 'Thinking...'), `which no code block swallows (got ${json(frameMarkdown)})`);
        const final = richMarkdownOf(editsOf(started.telegram, started.firstMessageId).at(-1)) ?? '';
        expect(final.endsWith('\n\n<p>[stopped]</p>') && !landsInCode(final, '[stopped]'), `nor the stop marker (got ${json(final)})`);
    })
);

results.push(
    await runCase('case 4: a refused second frame demotes the reply: entities from there on, logged once, finalized once', async () => {
        // The fake's refusal reaches the code as a real GrammyError
        const probe = createFakeTelegram({ refuse: () => ({ error_code: 400, description: 'Bad Request: probe' }) });
        const thrown = await probe.api.sendMessage(1, 'x').then(
            () => null,
            (error: unknown) => error
        );
        expect(thrown instanceof GrammyError && thrown.error_code === 400 && thrown.description === 'Bad Request: probe', 'grammY turns ok:false into a GrammyError');

        let richEdits = 0;
        const started = await startReply({
            richReplies: true,
            refuse: (call) => {
                if (call.payload.rich_message === undefined) return null;
                richEdits += 1;
                return richEdits === 2 ? { error_code: 400, description: 'Bad Request: too many rich blocks' } : null;
            },
        });
        const logs = await runReply(started, { steps: textSteps(['第一句。', '第二句。', '第三句。', '第四句。']) });
        const edits = editsOf(started.telegram, started.firstMessageId);
        const refusedAt = edits.findIndex((call, index) => isRichCall(call) && edits.slice(0, index + 1).filter(isRichCall).length === 2);
        expect(refusedAt === 1, `the second edit is the refused rich frame (got ${refusedAt})`);
        const later = edits.slice(refusedAt + 1);
        expect(
            later.length >= 2 && later.every((call) => !isRichCall(call) && typeof call.payload.text === 'string'),
            `every later edit is text with entities (got ${json(later.map((call) => Object.keys(call.payload)))})`
        );
        expect(textOf(later.at(-1)) === '第一句。第二句。第三句。第四句。', `the final is entities (got ${json(textOf(later.at(-1)))})`);
        expect(started.telegram.callsOf('sendRichMessage').length === 0, 'nothing is sent rich');
        const fallbacks = fallbacksIn(logs);
        expect(
            fallbacks.length === 1 &&
                fallbacks[0] ===
                    `[rich] fallback to entities chat=${started.chatId} first=${started.firstMessageId} reason=stream-rejected detail=Bad Request: too many rich blocks`,
            `one fallback line (got ${json(fallbacks)})`
        );
        expect(deliveredIn(logs).length === 0, 'no success line');
        expect((await versionsOf(started)).length === 1, 'finalize ran once');
    })
);

results.push(
    await runCase('case 5: a refused final is laid out again as entities; the image goes out once and carries the buttons', async () => {
        let refuseRich = false;
        const started = await startReply({
            richReplies: true,
            refuse: (call) =>
                refuseRich && call.payload.rich_message !== undefined
                    ? { error_code: 400, description: 'Bad Request: rich message refused' }
                    : null,
        });
        markPendingEditWhileProcessing(started.chatId, started.userMessageId);
        const logs = await runReply(
            started,
            {
                steps: [
                    ...textSteps(['图来了，', '请看下面。']),
                    { chunk: { type: 'image', imageData: PNG_BYTES, imageCaption: '一张图' }, frame: false },
                ],
            },
            {
                beforeFinal: () => {
                    refuseRich = true;
                },
            }
        );
        const { telegram } = started;
        const edits = editsOf(telegram, started.firstMessageId);
        const refusedIndex = edits.findIndex((call) => isRichCall(call) && !RICH_STATUS_LINE.test(richMarkdownOf(call) ?? ''));
        expect(refusedIndex !== -1, 'the final rich edit was tried');
        const relayout = edits.slice(refusedIndex + 1);
        expect(
            relayout.length === 1 && textOf(relayout[0]) === '图来了，请看下面。',
            `the entities re-layout rewrote the message (got ${json(relayout.map((call) => call.payload))})`
        );
        expect(telegram.callsOf('sendPhoto').length === 1, `the image went out once (got ${telegram.callsOf('sendPhoto').length})`);
        const [version, ...more] = await versionsOf(started);
        expect(version !== undefined && more.length === 0, 'one version');
        expect(version?.messageIds.length === 2, `the message and the image (got ${json(version?.messageIds)})`);
        const buttons = telegram.callsOf('editMessageReplyMarkup');
        expect(
            buttons.length === 1 && buttons[0]?.payload.message_id === version?.currentMessageId && version?.currentMessageId !== started.firstMessageId,
            `the buttons land on the image (got ${json(buttons.map((call) => call.payload.message_id))})`
        );
        const fallbacks = fallbacksIn(logs);
        expect(
            fallbacks.length === 1 && fallbacks[0]?.endsWith('reason=final-rejected detail=Bad Request: rich message refused') === true,
            `one fallback line (got ${json(fallbacks)})`
        );
    })
);

results.push(
    await runCase('case 6: an answer past the rich budget demotes; the entities split and the final layout take over', async () => {
        const started = await startReply({ richReplies: true });
        const paragraphs = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段：${'内容很长。'.repeat(790)}\n\n`);
        const logs = await runReply(started, { steps: textSteps(paragraphs) });
        const { telegram } = started;
        const richCalls = telegram.calls.filter(isRichCall);
        // Counted by content: a spinner refresh under load repeats a frame with another status word
        const frameContents = new Set(richCalls.map((call) => (richMarkdownOf(call) ?? '').replace(RICH_STATUS_LINE, '')));
        expect(frameContents.size === 7, `seven frames fit the budget (got ${frameContents.size})`);
        expect(
            richCalls.every((call) => (richMarkdownOf(call)?.length ?? 0) <= RICH_MAX_SOURCE_LENGTH + 100),
            'none of them over the budget'
        );
        const fallbacks = fallbacksIn(logs);
        const detail = Number(/detail=(\d+)$/.exec(fallbacks[0] ?? '')?.[1]);
        expect(
            fallbacks.length === 1 && fallbacks[0]?.includes('reason=overflow') === true && detail > RICH_MAX_SOURCE_LENGTH,
            `one overflow line with the length (got ${json(fallbacks)})`
        );
        const lastRich = richCalls.at(-1);
        const afterDemotion = lastRich === undefined ? [] : telegram.calls.slice(telegram.calls.indexOf(lastRich) + 1);
        expect(afterDemotion.length > 0 && afterDemotion.every((call) => !isRichCall(call)), 'nothing rich after the demotion');
        expect(telegram.callsOf('sendMessage').some((call) => textOf(call) === 'continued'), 'the stream split into a continuation');
        const [version] = await versionsOf(started);
        expect(version?.text === paragraphs.join(''), 'the stored text is the whole answer');
        expect((version?.messageIds.length ?? 0) >= 8, `the final layout spans the messages it needs (got ${version?.messageIds.length})`);
        const textCalls = afterDemotion.filter((call) => call.method === 'editMessageText' || call.method === 'sendMessage');
        expect(textCalls.every((call) => textOf(call).length <= 4096), 'every message fits Telegram');
        expect(deliveredIn(logs).length === 0, 'no success line');
    })
);

results.push(
    await runCase('case 7: link mode: the link message stays entities with its card, the body continuation goes rich', async () => {
        const started = await startReply({ richReplies: true });
        const logs = await runReply(started, {
            steps: [...thinkingSteps(longThinking()), ...textSteps(['答案来了。', '第二句。'])],
        });
        const { telegram, chatContext } = started;
        const link = chatContext.session.thinkingLink;
        expect(link?.emitted === true, 'the link was emitted');
        const linkEdits = editsOf(telegram, started.firstMessageId);
        const lastLinkEdit = linkEdits.at(-1);
        expect(
            textOf(lastLinkEdit).startsWith(THINKING_LINK_LABEL) &&
                Array.isArray(lastLinkEdit?.payload.entities) &&
                asRecord(lastLinkEdit?.payload.link_preview_options).url === link?.fastPageUrl,
            `the link message is entities with its preview card (got ${json(lastLinkEdit?.payload)})`
        );
        const continuation = telegram.callsOf('sendMessage').find((call) => textOf(call) === 'continued');
        expect(continuation !== undefined, 'the body opened a continuation');
        const [, bodyMessageId] = chatContext.session.messageIds;
        expect(bodyMessageId !== undefined, 'the body has its own message');
        const bodyEdits = editsOf(telegram, bodyMessageId);
        expect(bodyEdits.length >= 2 && bodyEdits.every(isRichCall), `the body streams and ends rich (got ${bodyEdits.length})`);
        const finalEdit = bodyEdits.at(-1);
        expect(richMarkdownOf(finalEdit) === '答案来了。第二句。', `the final body shows no thinking (got ${json(richMarkdownOf(finalEdit))})`);
        const continuationIndex = continuation === undefined ? -1 : telegram.calls.indexOf(continuation);
        const linkEditIndex = lastLinkEdit === undefined ? -1 : telegram.calls.indexOf(lastLinkEdit);
        expect(
            linkEditIndex !== -1 && continuationIndex > linkEditIndex,
            'the link message takes no edit once the body opened: the final edits only the body'
        );
        const [version] = await versionsOf(started);
        expect(version?.thinkingLinkToken === link?.token, 'the version stores the link token');
        expect(deliveredIn(logs)[0]?.endsWith('link=true searchLink=false') === true, `the success line names the link (got ${json(deliveredIn(logs))})`);
    })
);

results.push(
    await runCase('case 8: a thinking past 4000 characters at the final leads with a new link message, then the rich body', async () => {
        const started = await startReply({ richReplies: true });
        // The answer starts first: link mode never activates while streaming
        const logs = await runReply(started, { steps: [...textSteps(['答案。']), ...thinkingSteps(longThinking())] });
        const { telegram, chatContext } = started;
        const link = chatContext.session.thinkingLink;
        expect(link !== undefined && link.emitted === false, 'the final created the link');
        const lastFirst = editsOf(telegram, started.firstMessageId).at(-1);
        expect(
            textOf(lastFirst).startsWith(THINKING_LINK_LABEL) && asRecord(lastFirst?.payload.link_preview_options).url === link?.fastPageUrl,
            `the first message became the entities link message (got ${json(lastFirst?.payload)})`
        );
        const sent = telegram.callsOf('sendRichMessage');
        expect(sent.length === 1, `the body went out as a new rich message (got ${sent.length})`);
        expect(richMarkdownOf(sent[0]) === '答案。', `without the thinking (got ${json(richMarkdownOf(sent[0]))})`);
        expect(asRecord(sent[0]?.payload.reply_parameters).message_id === started.userMessageId, 'replying to the question');
        const [version] = await versionsOf(started);
        expect(version?.thinkingLinkToken === link?.token && version?.messageIds.length === 2, 'the version stores the link and both messages');
        expect(deliveredIn(logs)[0]?.includes('link=true') === true, 'the success line names the link');
    })
);

results.push(
    await runCase('case 9: a folded search footer trails the rich body as an entities link message; a small one stays inline', async () => {
        const folded = await startReply({ richReplies: true });
        const logs = await runReply(folded, {
            steps: [{ chunk: textChunk('搜到了：答案。') }, { chunk: { type: 'grounding', groundingMetadata: bigFooter() }, frame: false }],
        });
        const body = richMarkdownOf(editsOf(folded.telegram, folded.firstMessageId).at(-1));
        expect(body === '搜到了：答案。', `the body carries no footer (got ${json(body)})`);
        const linkMessage = folded.telegram.callsOf('sendMessage').at(-1);
        expect(
            textOf(linkMessage).startsWith(SEARCH_LINK_LABEL) && typeof asRecord(linkMessage?.payload.link_preview_options).url === 'string',
            `the search link message follows with its card (got ${json(linkMessage?.payload)})`
        );
        const [version] = await versionsOf(folded);
        expect(version?.searchLinkToken !== undefined && version.messageIds.length === 2, 'the version stores the page token and both messages');
        expect(deliveredIn(logs)[0]?.endsWith('link=false searchLink=true') === true, `the success line names the fold (got ${json(deliveredIn(logs))})`);

        const inline = await startReply({ richReplies: true });
        await runReply(inline, {
            steps: [{ chunk: textChunk('搜到了：小答案。') }, { chunk: { type: 'grounding', groundingMetadata: smallFooter() }, frame: false }],
        });
        const inlineBody = richMarkdownOf(editsOf(inline.telegram, inline.firstMessageId).at(-1)) ?? '';
        expect(
            inlineBody.startsWith('搜到了：小答案。\n\n') && inlineBody.includes('<b>GoogleSearch</b>') && inlineBody.includes('<blockquote expandable>'),
            `the small footer rides in the body as HTML (got ${json(inlineBody)})`
        );
        expect(inline.telegram.callsOf('sendMessage').length === 1, 'no message besides the placeholder');
    })
);

results.push(
    await runCase('case 10: a media-only reply makes no rich call at all', async () => {
        const started = await startReply({ richReplies: true });
        await runReply(started, { steps: [{ chunk: { type: 'image', imageData: PNG_BYTES }, frame: false }] });
        const { telegram } = started;
        expect(telegram.calls.every((call) => !isRichCall(call)), `no rich call (got ${json(telegram.calls.map((call) => call.method))})`);
        expect(telegram.callsOf('sendPhoto').length === 1, 'the image went out');
        expect(
            telegram.callsOf('deleteMessage').some((call) => call.payload.message_id === started.firstMessageId),
            'and took the placeholder\'s place'
        );
    })
);

results.push(
    await runCase('case 11: a failure shows the rich error display; a refused one falls back to the entities display', async () => {
        const failure = (): FailingStream => ({
            steps: [{ chunk: thinkingChunk('想到一半') }, ...textSteps(['答到一半，', '还有']) ],
            failure: new Error('got status: 500 Internal Server Error'),
        });
        const started = await startReply({ richReplies: true });
        const logs = await runReply(started, failure());
        const errorEdit = editsOf(started.telegram, started.firstMessageId).at(-1);
        const markdown = richMarkdownOf(errorEdit) ?? '';
        expect(
            markdown ===
                '<blockquote expandable>想到一半</blockquote>\n\n答到一半，还有\n\n<p><i>⚠ got status: 500 Internal Server Error</i></p>',
            `thinking quote, partial answer, error line (got ${json(markdown)})`
        );
        expect(json(labelsOf(errorEdit)) === json(['重试']), `with the retry button (got ${json(labelsOf(errorEdit))})`);
        expect(fallbacksIn(logs).length === 0, 'no fallback');
        const [version] = await versionsOf(started);
        expect(version?.errorMessage !== undefined && version.text === '答到一半，还有', 'the version stores the partial text and the error');

        const refused = await startReply({
            richReplies: true,
            refuse: (call) => (richMarkdownOf(call)?.includes('⚠') === true ? { error_code: 400, description: 'Bad Request: refused' } : null),
        });
        const refusedLogs = await runReply(refused, failure());
        const entitiesError = editsOf(refused.telegram, refused.firstMessageId).at(-1);
        expect(
            !isRichCall(entitiesError ?? { method: '', payload: {} }) &&
                textOf(entitiesError).includes('⚠ got status: 500 Internal Server Error') &&
                json(labelsOf(entitiesError)) === json(['重试']),
            `the entities error display follows, with the retry button (got ${json(entitiesError?.payload)})`
        );
        const fallbacks = fallbacksIn(refusedLogs);
        expect(
            fallbacks.length === 1 && fallbacks[0]?.endsWith('reason=error-rejected detail=Bad Request: refused') === true,
            `one fallback line (got ${json(fallbacks)})`
        );
    })
);

results.push(
    await runCase(
        'case 11: a kept checkpoint adds "已保留前 N 轮" to the rich error display',
        quietCase(async () => {
            const chatId = takeChatId();
            await updateChatSettings({ chatId, patch: { richReplies: true }, actor: OWNER });
            try {
                await bench.failedAfterRound1({ label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] }, { chatId });
                const errorEdit = bench.telegram.callsOf('editMessageText').filter(isRichCall).at(-1);
                const markdown = richMarkdownOf(errorEdit) ?? '';
                expect(
                    markdown.endsWith('<p><i>⚠ Request contains an invalid argument.</i><br><i>已保留前 1 轮</i></p>') ||
                        /<p><i>⚠ [^<]+<\/i><br><i>已保留前 1 轮<\/i><\/p>$/.test(markdown),
                    `the error and the kept rounds close the display (got ${json(markdown.slice(-120))})`
                );
                expect(json(labelsOf(errorEdit)) === json(['继续', '重试']), `with [继续] [重试] (got ${json(labelsOf(errorEdit))})`);
            } finally {
                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
            }
        })
    )
);

results.push(
    await runCase('case 12: a stop puts [stopped] inside the rich body', async () => {
        const started = await startReply({ richReplies: true });
        await runReply(started, {
            steps: [
                ...textSteps(['说到一半', '，还没说完']),
                {
                    chunk: textChunk('不会显示'),
                    frame: false,
                    before: () => started.chatContext.session.streamController.abort(),
                },
            ],
        });
        const final = richMarkdownOf(editsOf(started.telegram, started.firstMessageId).at(-1));
        expect(final === '说到一半，还没说完\n\n<p>[stopped]</p>', `the stop marker is its own paragraph (got ${json(final)})`);
        const [version] = await versionsOf(started);
        expect(version?.wasStoppedByUser === true && version.text === '说到一半，还没说完', 'the version records the stop');
    })
);

results.push(
    await runCase(
        'case 13: 重试 follows the switch as the click finds it; the placeholder is plain text, then rich edits',
        quietCase(async () => {
            const chatId = takeChatId();
            const { telegram, vertex } = bench;
            await updateChatSettings({ chatId, patch: { richReplies: true }, actor: OWNER });
            try {
                vertex.reset([answer('第一版的回答。')]);
                telegram.reset();
                const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 说点什么');
                const firstFinal = telegram.calls.filter(isRichCall).at(-1);
                expect(richMarkdownOf(firstFinal)?.endsWith('第一版的回答。') === true, `the chat handler made the reply rich (got ${json(richMarkdownOf(firstFinal))})`);

                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
                vertex.reset([answer('第二版的回答。')]);
                telegram.reset();
                await bench.retryReply(reply);
                expect(telegram.calls.every((call) => !isRichCall(call)), 'switched off: the new version is entities');
                expect(
                    textOf(telegram.callsOf('editMessageText').at(-1)).endsWith('第二版的回答。'),
                    `and ends as text (got ${json(textOf(telegram.callsOf('editMessageText').at(-1)))})`
                );

                await updateChatSettings({ chatId, patch: { richReplies: true }, actor: OWNER });
                vertex.reset([answer('第三版的回答。')]);
                telegram.reset();
                await bench.retryReply(reply);
                const edits = telegram.callsOf('editMessageText');
                expect(
                    textOf(edits[0]) === '✽ Thinking...' && !isRichCall(edits[0] ?? { method: '', payload: {} }),
                    `the retry first edits the message back to the plain placeholder (got ${json(edits[0]?.payload)})`
                );
                // The scripted model answers within the update throttle: frames may coalesce into the final
                expect(
                    edits.slice(1).length >= 1 && edits.slice(1).every(isRichCall),
                    `then every edit is rich (got ${json(edits.slice(1).map((call) => Object.keys(call.payload)))})`
                );
                expect(richMarkdownOf(edits.at(-1))?.endsWith('第三版的回答。') === true, 'ending with the new answer');
                expect((await bench.stored(reply)).getVersions().length === 3, 'three versions');
            } finally {
                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
            }
        })
    )
);

results.push(
    await runCase(
        'case 14: 继续 stays ready whatever the switch says, and the resumed version follows it',
        quietCase(async () => {
            const chatId = takeChatId();
            const { telegram, vertex } = bench;
            const reply = await bench.failedAfterRound1({ label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] }, { chatId });
            try {
                for (const richReplies of [true, false, true]) {
                    await updateChatSettings({ chatId, patch: { richReplies }, actor: OWNER });
                    const ctx = contextOf(
                        callbackUpdate({ chatId, messageId: reply.firstMessageId, userId: FULL_USER_ID, data: 'resp:continue' }),
                        telegram
                    );
                    const check = await checks.checkContinue(ctx, await bench.stored(reply), bench.registry);
                    expect(check.kind === 'ready', `switch ${String(richReplies)}: ready (got ${json(check)})`);
                }
                vertex.reset([answer('接着说完。')]);
                telegram.reset();
                await bench.continueReply(reply);
                const final = telegram.calls.filter(isRichCall).at(-1);
                expect(richMarkdownOf(final)?.includes('接着说完。') === true, `the resumed version is rich (got ${json(richMarkdownOf(final))})`);
            } finally {
                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
            }
        })
    )
);

results.push(
    await runCase(
        'the switch flipped while a reply runs does not change its form halfway',
        quietCase(async () => {
            const chatId = takeChatId();
            const { telegram, vertex } = bench;
            await updateChatSettings({ chatId, patch: { richReplies: true }, actor: OWNER });
            try {
                vertex.reset([stalledRound('还在想', '说到一半')]);
                telegram.reset();
                const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 慢慢说');
                await waitUntil('the answer to stream', () =>
                    botMessageService.listActiveSessions().some((session) => session.chatId === chatId && session.textBuffer === '说到一半')
                );
                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
                await bench.stopReply(await bench.runningReplyOf(chatId));
                await asked.done;
                const final = telegram.callsOf('editMessageText').at(-1);
                expect(
                    richMarkdownOf(final) === '<blockquote expandable>还在想</blockquote>\n\n说到一半\n\n<p>[stopped]</p>',
                    `the reply ends rich as it started (got ${json(final?.payload)})`
                );
            } finally {
                await updateChatSettings({ chatId, patch: { richReplies: false }, actor: OWNER });
            }
        })
    )
);

results.push(
    await runCase('case 15: /picbanana and /picgpt contexts never go rich', async () => {
        for (const commandType of ['picbanana', 'picgpt'] as const) {
            const started = await startReply({ richReplies: true, commandType });
            expect(started.chatContext.delivery === 'entities', `${commandType}: the context is entities`);
            await runReply(started, { steps: textSteps(['只有文字，']) });
            expect(started.telegram.calls.every((call) => !isRichCall(call)), `${commandType}: no rich call`);

            const session = await quietly(() =>
                botMessageService.startRetry(started.chatContext.ctx, started.firstMessageId, { model: MODEL })
            );
            if (session === null) throw new Error('offline: the retry session did not start');
            const retry = trackReply(
                responseHandler.createChatContextForRetry(started.chatContext.ctx, session, commandType, { richReplies: true })
            );
            expect(retry.delivery === 'entities', `${commandType}: its retry context is entities too`);
            await runReply({ ...started, chatContext: retry }, { steps: textSteps(['重试也只有文字，']) });
            expect(started.telegram.calls.every((call) => !isRichCall(call)), `${commandType}: no rich call in the retry`);
        }
    })
);

endOpenReplies();
await bench.close();
reportResults(results);
