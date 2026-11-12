/**
 * Offline cases for keeping the checkpoint of a failed or stopped reply and
 * offering "继续" (design 2026-1112-1123 §6.1, §6.3, §6.6, §7.3, §11 phase 3
 * cases 2, 3, 11, 15, 17), driven through the real chat and retry handlers.
 *
 * The model is a stub: the Gemini platform singleton's sendMessage is replaced
 * by a script that hands checkpoints built by hand to config.checkpointSink,
 * streams chunks, and then fails, is stopped, or ends. Telegram is the fake
 * Bot API; the database is the scratch file.
 *
 * Covered: an error with a checkpoint ([继续] [重试], the kept rounds line,
 * checkpointRounds and the tool usage on the failed row), a 400 alike, no
 * "继续" without a checkpoint or after a normal end; a stop with one (the
 * buffered sticker, file and widget still delivered, no extra text) on the
 * stream path, the abort-error path and the split final message; a retry
 * ending the mark and the entry; a second failure replacing the first; the
 * version switch, the refreshes and the edit redraw showing "继续" only on the
 * failed latest version; the health count; an entry too big to keep; an
 * entry holding none of the attempt's live objects; the in-flight mark of a
 * first message a media-only retry replaced.
 *
 * Run: npx tsx scripts/offline/reply-resume-save.mts
 */
import { Hono } from 'hono';
import { Api, Context } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeBot,
    createFakeTelegram,
    endOpenReplies,
    lastToastOf,
    messageUpdate,
    quietly,
    trackReply,
    waitUntil,
    type FakeTelegram,
} from './fake-telegram.mts';
import { withFakeClock } from './support/gemini-loop-fixtures.mts';
import type { AgentToolUsage, PlatformConfig, StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolLoopCheckpoint } from '../../src/ai/tools/tool-loop-checkpoint.js';

const MODEL = 'gemini-4-carbon';
// Read at import: the chats' model, the bot's name, a group widget's delivery
process.env.DEFAULT_MODEL = MODEL;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
process.env.WIDGET_GROUP_FALLBACK = '1';
process.env.WIDGET_RENDER_URL = '';

await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { getPlatform } = await import('../../src/ai/platform-factory.js');
const { handleReply } = await import('../../src/reply/chat-handler.js');
const { handleRetryRequest } = await import('../../src/reply/retry-handler.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const { checkpointRegistry, CHECKPOINT_REGISTRY_LIMITS } = await import('../../src/reply/resume/checkpoint-registry.js');
const { captureResumeFacts } = await import('../../src/reply/resume/resume-facts.js');
const { createReplyToolState } = await import('../../src/reply/tools/reply-tool-state.js');
const { findReplyMetricsByReply } = await import('../../src/db/queries/reply-metrics.js');
const { registerResponseCallbacks } = await import('../../src/cmd/menus/response-menu.js');
const { registerHealthRoute } = await import('../../src/panel/routes/health.js');
const { autoUpdate } = await import('../../src/db/autoSave.js');
const state = await import('../../src/state.js');

type BotMessageSession = import('../../src/services/bot-message-service.js').BotMessageSession;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type ReplyMetricRecord = import('../../src/db/queries/reply-metric-rows.js').ReplyMetricRecord;

const USER_ID = 5150;
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const json = (value: unknown): string => JSON.stringify(value);

// ---- the stub model: a script per request ----

type Step =
    | { readonly checkpoint: ToolLoopCheckpoint }
    | { readonly chunk: StreamChunk }
    | { readonly fail: Error }
    /** A click on 停止, then what the stream does next: one more chunk, or the SDK's abort error */
    | { readonly stop: 'then-chunk' | 'then-abort-error' };

/** The script the next request runs */
let script: readonly Step[] = [];
const requests: PlatformConfig[] = [];
/** The session of every request, found by its signal: for the reference checks */
const sessionsSeen: BotMessageSession[] = [];

const sessionOf = (config: PlatformConfig): BotMessageSession | undefined =>
    botMessageService.listActiveSessions().find((session) => session.streamController.signal === config.signal);

const runScript = async function* (steps: readonly Step[], config: PlatformConfig): AsyncGenerator<StreamChunk> {
    for (const step of steps) {
        if ('checkpoint' in step) {
            config.checkpointSink?.(step.checkpoint);
        } else if ('chunk' in step) {
            yield step.chunk;
        } else if ('fail' in step) {
            throw step.fail;
        } else {
            const session = sessionOf(config);
            if (session === undefined) throw new Error('offline: no session to stop');
            await botMessageService.stopResponse(session.chatId, session.firstMessageId);
            if (step.stop === 'then-abort-error') throw new Error('Aborted');
            yield { type: 'text', content: '停止之后才到的字' };
        }
    }
};

const platform = getPlatform(MODEL);
platform.sendMessage = async (_messages: UnifiedMessage[], config: PlatformConfig) => {
    requests.push(config);
    const session = sessionOf(config);
    if (session !== undefined) sessionsSeen.push(session);
    return runScript(script, config);
};

// ---- checkpoints and chunks ----

const TOOL_USAGE: AgentToolUsage[] = [
    { name: 'search_history', count: 2 },
    { name: 'fetch_image', count: 1, failed: 1 },
];

const checkpointOf = (completedRounds: number, fields: Partial<ToolLoopCheckpoint> = {}): ToolLoopCheckpoint => ({
    platform: 'gemini',
    completedRounds,
    toolUsage: TOOL_USAGE,
    journal: [
        { type: 'thinking', content: '先想想' },
        { type: 'text', content: '先查一下。' },
    ],
    state: { nextRound: completedRounds + 1, contents: [{ role: 'user', parts: [{ text: '查一下' }] }] },
    ...fields,
});

const STICKER = { packIndex: 7, label: '吃冰棒', emoji: '🍦', fileId: 'file-7', fileUniqueId: 'unique-7' };
const FILE = { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('# 笔记\n'), caption: '笔记' };
const WIDGET_HTML = '<div class="tw-root">停下时的卡片</div>';
const WIDGET = {
    mode: 'html' as const,
    html: WIDGET_HTML,
    caption: '卡片',
    htmlBytes: Buffer.byteLength(WIDGET_HTML),
    zlibBytes: 40,
};

/** What the loop streams for its kept rounds, then the checkpoint it hands over */
const keptRounds = (rounds: number, fields: Partial<ToolLoopCheckpoint> = {}): Step[] => [
    { chunk: { type: 'thinking', content: '先想想' } },
    { chunk: { type: 'text', content: '先查一下。' } },
    { checkpoint: checkpointOf(rounds, fields) },
    // The interrupted round's half-written answer, not part of the checkpoint
    { chunk: { type: 'text', content: '然后' } },
];

const DONE: Step = { chunk: { type: 'done', rawResponse: { candidates: [{ finishReason: 'STOP' }] } } };

// ---- driving the handlers ----

interface ReplyRun {
    readonly chatId: number;
    readonly firstMessageId: number;
    readonly userMessageId: number;
    readonly telegram: FakeTelegram;
}

const runReply = async (chatId: number, steps: readonly Step[]): Promise<ReplyRun> => {
    const userMessageId = takeMessageId();
    const text = '@AfterSchoolTeatimeBot 查一下';
    await dbIndex.saveMessage({ chatId, messageId: userMessageId, userId: USER_ID, date: new Date(), userName: 'u', message: text });
    const telegram = createFakeTelegram();
    script = steps;
    await quietly(() => handleReply(contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text }), telegram), { mention: true }));
    const response = await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId } });
    if (!response) throw new Error('the reply was not recorded');
    return { chatId, firstMessageId: response.messageId, userMessageId, telegram };
};

const runRetry = async (run: ReplyRun, steps: readonly Step[]): Promise<FakeTelegram> => {
    const telegram = createFakeTelegram();
    script = steps;
    const ctx = contextOf(
        callbackUpdate({ chatId: run.chatId, messageId: run.firstMessageId, userId: USER_ID, data: 'resp:retry' }),
        telegram
    );
    await quietly(() => handleRetryRequest(ctx, run.firstMessageId));
    return telegram;
};

// ---- reading what happened ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The labels of a reply_markup, or null when the call carried none */
const keyboardLabels = (markup: unknown): string[] | null => {
    if (!isRecord(markup) && !(typeof markup === 'object' && markup !== null)) return null;
    const rows: unknown = Reflect.get(markup, 'inline_keyboard');
    if (!Array.isArray(rows)) return null;
    return rows.flat().map((button: unknown) => (isRecord(button) ? String(button.text) : ''));
};

/** The buttons the reply was left with: the last call that carried any */
const finalButtonsOf = (telegram: FakeTelegram): string[] => {
    for (const call of [...telegram.calls].reverse()) {
        const labels = keyboardLabels(call.payload.reply_markup);
        if (labels !== null) return labels;
    }
    return [];
};

const everOffersContinue = (telegram: FakeTelegram): boolean =>
    telegram.calls.some((call) => (keyboardLabels(call.payload.reply_markup) ?? []).includes('继续'));

const lastEditTextOf = (telegram: FakeTelegram): string => {
    const text = telegram.callsOf('editMessageText').at(-1)?.payload.text;
    return typeof text === 'string' ? text : '';
};

const rowsOf = (run: ReplyRun): Promise<ReplyMetricRecord[]> => findReplyMetricsByReply(run.chatId, run.firstMessageId);

const storedOf = async (run: ReplyRun) => {
    const stored = await dbIndex.getBotResponse(run.chatId, run.firstMessageId);
    if (!stored) throw new Error('no stored reply');
    return stored;
};

const markOf = (run: ReplyRun) => state.resumableMarkOf(run.chatId, run.firstMessageId);
const entryOf = (run: ReplyRun) => checkpointRegistry.peek(run.chatId, run.firstMessageId);

const describe = (run: ReplyRun, telegram: FakeTelegram = run.telegram): string =>
    json({ buttons: finalButtonsOf(telegram), text: lastEditTextOf(telegram).slice(-80), mark: markOf(run) });

let nextChatId = -1007400000000;
const takeChatId = (): number => (nextChatId -= 1);

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'case 2: an error with a checkpoint offers [继续] [重试], says how many rounds are kept, and the row records them',
        body: async () => {
            const run = await runReply(takeChatId(), [
                ...keptRounds(2),
                { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') },
            ]);
            expect(requests.at(-1)?.checkpointSink !== undefined, 'the chat handler passes a checkpoint sink');
            expect(json(finalButtonsOf(run.telegram)) === json(['继续', '重试']), `buttons (got ${describe(run)})`);
            const text = lastEditTextOf(run.telegram);
            const errorAt = text.indexOf('⚠');
            const keptAt = text.indexOf('已保留前 2 轮');
            expect(errorAt >= 0 && keptAt > errorAt, `the kept rounds line follows the error line (got ${json(text)})`);
            expect(markOf(run)?.versionId === 1, 'version 1 is marked resumable');

            const entry = entryOf(run);
            expect(
                entry?.loop.completedRounds === 2 && entry.failedVersionId === 1 && entry.userMessageId === run.userMessageId,
                `the registry keeps the checkpoint (got ${json({ rounds: entry?.loop.completedRounds, version: entry?.failedVersionId })})`
            );
            expect(
                entry?.request.model === MODEL &&
                    entry.request.systemPrompt === requests.at(-1)?.systemPrompt &&
                    entry.request.toolDefinitionsJson.startsWith('[') &&
                    entry.context.contextMessageIds.includes(run.userMessageId) &&
                    entry.context.numbering.size === entry.context.contextIndex.size &&
                    entry.context.promptAddendum === null &&
                    entry.context.requestTraits.carriesLargeMedia === false,
                'with the facts of the build and of the request'
            );
            expect(entry?.loop.journal.length === 2, 'the half-written round is not in it');

            const [row] = await rowsOf(run);
            expect(
                row?.outcome === 'error' && row.checkpointRounds === 2 && row.toolCalls === 3 && row.toolFailures === 1,
                `the failed row records the kept rounds and the tool usage (got ${json({ outcome: row?.outcome, checkpointRounds: row?.checkpointRounds, toolCalls: row?.toolCalls })})`
            );
            const version = (await storedOf(run)).getVersions().at(-1);
            expect(
                json(version?.agentStats?.toolUsage) === json(TOOL_USAGE) && version?.errorMessage !== undefined,
                'the stored failed version carries the tool usage too'
            );
        },
    },
    {
        name: 'case 2: a 400 keeps its checkpoint the same way: the kind of error does not matter',
        body: async () => {
            const run = await runReply(takeChatId(), [
                ...keptRounds(1),
                { fail: new Error('got status: 400 INVALID_ARGUMENT. Request contains an invalid argument.') },
            ]);
            expect(json(finalButtonsOf(run.telegram)) === json(['继续', '重试']), `buttons (got ${describe(run)})`);
            expect(lastEditTextOf(run.telegram).includes('已保留前 1 轮'), 'the line names one round');
            const [row] = await rowsOf(run);
            expect(row?.checkpointRounds === 1, `checkpointRounds (got ${row?.checkpointRounds})`);
        },
    },
    {
        name: 'case 2: no 继续 when round 1 failed or was stopped without a checkpoint, nor after a normal end',
        body: async () => {
            const failed = await runReply(takeChatId(), [
                { chunk: { type: 'thinking', content: '想到一半' } },
                { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') },
            ]);
            expect(json(finalButtonsOf(failed.telegram)) === json(['重试']), `a failed round 1 offers only 重试 (got ${describe(failed)})`);
            expect(!lastEditTextOf(failed.telegram).includes('已保留'), 'and keeps nothing');
            const [failedRow] = await rowsOf(failed);
            expect(
                failedRow?.checkpointRounds === null && failedRow.toolCalls === 0 && markOf(failed) === undefined && entryOf(failed) === undefined,
                `no checkpointRounds, no mark, no entry (got ${json(failedRow?.checkpointRounds)})`
            );

            const stopped = await runReply(takeChatId(), [
                { chunk: { type: 'text', content: '说到一半' } },
                { stop: 'then-chunk' },
            ]);
            expect(json(finalButtonsOf(stopped.telegram)) === json(['重试']), `a stopped round 1 offers only 重试 (got ${describe(stopped)})`);
            const [stoppedRow] = await rowsOf(stopped);
            expect(
                stoppedRow?.outcome === 'stopped' && stoppedRow.checkpointRounds === null && markOf(stopped) === undefined,
                'and keeps nothing either'
            );

            const finished = await runReply(takeChatId(), [...keptRounds(1), { chunk: { type: 'text', content: '查完了。' } }, DONE]);
            const [finishedRow] = await rowsOf(finished);
            expect(
                !everOffersContinue(finished.telegram) &&
                    finishedRow?.outcome === 'ok' &&
                    finishedRow.checkpointRounds === null &&
                    markOf(finished) === undefined &&
                    entryOf(finished) === undefined,
                `a reply that ends normally keeps nothing (got ${describe(finished)})`
            );
        },
    },
    {
        name: 'case 3: a stop with a checkpoint offers [继续] [重试]; the buffered sticker, file and widget still go out; no extra text',
        body: async () => {
            const sticker = await runReply(takeChatId(), [
                { chunk: { type: 'text', content: '先发给你' } },
                { chunk: { type: 'sticker', sticker: STICKER } },
                { checkpoint: checkpointOf(1) },
                { stop: 'then-chunk' },
            ]);
            expect(sticker.telegram.callsOf('sendSticker')[0]?.payload.sticker === 'file-7', 'the sticker goes out');
            expect(json(finalButtonsOf(sticker.telegram)) === json(['继续', '重试']), `on the stream path (got ${describe(sticker)})`);
            expect(
                sticker.telegram.callsOf('editMessageReplyMarkup').length > 0 &&
                    json(keyboardLabels(sticker.telegram.callsOf('editMessageReplyMarkup').at(-1)?.payload.reply_markup)) ===
                        json(['继续', '重试']),
                'the buttons sit on the sticker, the last message'
            );
            const stickerText = lastEditTextOf(sticker.telegram);
            expect(!stickerText.includes('已保留') && !stickerText.includes('⚠'), `no extra text (got ${json(stickerText)})`);
            const [stickerRow] = await rowsOf(sticker);
            expect(stickerRow?.outcome === 'stopped' && stickerRow.checkpointRounds === 1, `the stopped row (got ${json(stickerRow?.checkpointRounds)})`);
            expect(markOf(sticker)?.versionId === 1 && entryOf(sticker)?.loop.completedRounds === 1, 'marked and kept');

            // The stop reaches the stream as the SDK's abort error: handleResponseError's stop branch
            const file = await runReply(takeChatId(), [
                { chunk: { type: 'text', content: '文件写好了' } },
                { chunk: { type: 'file', file: FILE } },
                { checkpoint: checkpointOf(2) },
                { stop: 'then-abort-error' },
            ]);
            expect(file.telegram.callsOf('sendDocument').length === 1, 'the file goes out');
            expect(json(finalButtonsOf(file.telegram)) === json(['继续', '重试']), `on the abort-error path (got ${describe(file)})`);
            const [fileRow] = await rowsOf(file);
            expect(fileRow?.outcome === 'stopped' && fileRow.checkpointRounds === 2, 'the stopped row records two rounds');
            expect(!lastEditTextOf(file.telegram).includes('已保留'), 'no extra text');

            const widget = await runReply(takeChatId(), [
                { chunk: { type: 'text', content: '卡片来了' } },
                { chunk: { type: 'widget', widget: WIDGET } },
                { checkpoint: checkpointOf(1) },
                { stop: 'then-chunk' },
            ]);
            const linkMessage = widget.telegram.callsOf('sendMessage').at(-1);
            const widgetVersion = (await storedOf(widget)).getVersions().at(-1);
            expect(
                linkMessage?.payload.text === '卡片' && widgetVersion?.widget?.deliveredAs === 'link' && widgetVersion.wasStoppedByUser,
                `the widget goes out (got ${json(widgetVersion?.widget?.deliveredAs)})`
            );
            expect(json(finalButtonsOf(widget.telegram)) === json(['继续', '重试']), `with the buttons (got ${describe(widget)})`);
        },
    },
    {
        name: 'case 3: a stopped reply whose final text needs several messages puts [继续] [重试] on the last one',
        body: async () => {
            const chatId = takeChatId();
            const telegram = createFakeTelegram();
            const userMessageId = takeMessageId();
            const ctx = contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text: '写长文' }), telegram);
            const chatContext = await quietly(() => responseHandler.createChatContext(ctx, { model: MODEL }));
            if (!chatContext) throw new Error('no chat context');
            trackReply(chatContext);
            const { session } = chatContext;
            chatContext.resumeFacts = captureResumeFacts({
                model: MODEL,
                systemPrompt: '系统提示词',
                tools: { definitions: [], execute: async () => ({ content: '', isError: false, images: [], record: null }), statusOf: () => ({ text: '', chatAction: 'typing' }) },
                toolState: createReplyToolState({ chatId, conversationRootIds: [] }),
                contextIndex: new Map(),
                conversationRootIds: [],
                requestTraits: { carriesLargeMedia: false },
                promptAddendum: null,
                builtAt: Date.now(),
            });
            chatContext.lastCheckpoint = checkpointOf(3);
            const longText = Array.from({ length: 40 }, (_unused, index) => `第 ${index + 1} 段：${'很长的内容。'.repeat(40)}`).join('\n\n');
            session.textBuffer = longText;
            session.streamController.abort();
            await quietly(() =>
                responseHandler.sendFinalResponse(chatContext, { text: longText, thinkingText: '', images: [], groundingData: [] })
            );
            expect(telegram.callsOf('sendMessage').length > 0, 'the text took more than one message');
            const run: ReplyRun = { chatId, firstMessageId: session.firstMessageId, userMessageId, telegram };
            expect(json(finalButtonsOf(telegram)) === json(['继续', '重试']), `buttons on the last part (got ${describe(run)})`);
            const [row] = await rowsOf(run);
            expect(row?.checkpointRounds === 3 && markOf(run)?.versionId === 1, 'kept and recorded');
        },
    },
    {
        name: 'case 11 and the order of the save: the mark survives its own finalization; 重试 clears it and the entry; a new failure replaces the entry',
        body: async () => {
            const run = await runReply(takeChatId(), [...keptRounds(2), { fail: new Error('got status: 500 INTERNAL') }]);
            expect(markOf(run)?.versionId === 1, 'the mark was set after the failed finalization cleared the old one');
            const healthBefore = state.countResumableReplies();

            const retryTelegram = await runRetry(run, [{ chunk: { type: 'text', content: '重新回答。' } }, DONE]);
            expect(markOf(run) === undefined, 'the retry finalization clears the mark');
            expect(entryOf(run) === undefined, 'and the registry no longer has the entry');
            expect(state.countResumableReplies() === healthBefore - 1, 'the count goes down');
            expect(!everOffersContinue(retryTelegram), 'the retried version offers no 继续');
            const rows = await rowsOf(run);
            expect(rows[1]?.checkpointRounds === null && rows[1].outcome === 'ok', 'the retry row keeps nothing');

            // The retry itself fails with its own checkpoint: version 3 is kept
            const failedAgain = await runRetry(run, [...keptRounds(4), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            expect(requests.at(-1)?.checkpointSink !== undefined, 'the retry handler passes a checkpoint sink');
            expect(markOf(run)?.versionId === 3 && entryOf(run)?.failedVersionId === 3, 'the retry failure is kept on version 3');
            expect(
                json(finalButtonsOf(failedAgain)) === json(['<', '继续', '重试']),
                `with several versions: [<] [继续] [重试] (got ${json(finalButtonsOf(failedAgain))})`
            );
            await runRetry(run, [...keptRounds(5), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            const replaced = entryOf(run);
            expect(
                replaced?.failedVersionId === 4 && replaced.loop.completedRounds === 5 && markOf(run)?.versionId === 4,
                `a second failure of the reply replaces the first entry (got ${json({ version: replaced?.failedVersionId })})`
            );
        },
    },
    {
        name: 'every finalization prunes the registry: an entry whose mark is gone, then one that expired, leave when another reply ends',
        body: async () => {
            const unmarked = await runReply(takeChatId(), [...keptRounds(2), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            expect(entryOf(unmarked) !== undefined, 'the first failure is kept');
            // The mark goes without the registry being touched
            state.clearReplyResumable(unmarked.chatId, unmarked.firstMessageId);
            const heldBefore = checkpointRegistry.size();
            await runReply(takeChatId(), [{ chunk: { type: 'text', content: '另一个回答。' } }, DONE]);
            expect(
                checkpointRegistry.size() === heldBefore - 1,
                `another reply's normal end drops it (held ${heldBefore}, then ${checkpointRegistry.size()})`
            );

            const expiring = await runReply(takeChatId(), [...keptRounds(1), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            expect(entryOf(expiring) !== undefined && checkpointRegistry.size() > 0, 'the second failure is kept');
            await withFakeClock(async (jump) => {
                jump(CHECKPOINT_REGISTRY_LIMITS.ttlMs + 1000);
                expect(checkpointRegistry.size() > 0, 'past its lifetime it is still held while nothing ends');
                await runReply(takeChatId(), [{ chunk: { type: 'text', content: '两小时后的回答。' } }, DONE]);
                expect(checkpointRegistry.size() === 0, `the next reply's end drops every expired entry (got ${checkpointRegistry.size()})`);
            });
        },
    },
    {
        name: 'case 17: switching versions, refreshing and the edit redraw show 继续 only on the failed latest version; the health count',
        body: async () => {
            const run = await runReply(takeChatId(), [{ chunk: { type: 'text', content: '第一版回答。' } }, DONE]);
            await runRetry(run, [...keptRounds(2), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            expect(markOf(run)?.versionId === 2, 'version 2 failed and is resumable');

            const switchTelegram = createFakeTelegram();
            const switchContext = contextOf(
                callbackUpdate({ chatId: run.chatId, messageId: run.firstMessageId, userId: USER_ID, data: 'resp:prev' }),
                switchTelegram
            );
            await quietly(() => botMessageService.switchVersion(switchContext, run.firstMessageId, 'prev'));
            expect(json(finalButtonsOf(switchTelegram)) === json(['重试', '>']), `the older version shows no 继续 (got ${json(finalButtonsOf(switchTelegram))})`);
            switchTelegram.reset();
            await quietly(() => botMessageService.switchVersion(switchContext, run.firstMessageId, 'next'));
            expect(
                json(finalButtonsOf(switchTelegram)) === json(['<', '继续', '重试']),
                `back on the failed latest version it shows again (got ${json(finalButtonsOf(switchTelegram))})`
            );

            const refreshTelegram = createFakeTelegram();
            await quietly(() => botMessageService.refreshToFinalState(refreshTelegram.api, run.chatId, run.firstMessageId));
            expect(json(finalButtonsOf(refreshTelegram)) === json(['<', '继续', '重试']), 'refreshToFinalState keeps it');

            // A button this version does not know: the refresh redraws the same buttons
            const { bot, telegram: botTelegram } = createFakeBot();
            registerResponseCallbacks(bot);
            await quietly(() =>
                bot.handleUpdate(callbackUpdate({ chatId: run.chatId, messageId: run.firstMessageId, userId: USER_ID, data: 'resp:rewind' }))
            );
            expect(lastToastOf(botTelegram) === '按钮已失效，已刷新', `the click falls to the unknown action (got ${String(lastToastOf(botTelegram))})`);
            expect(json(finalButtonsOf(botTelegram)) === json(['<', '继续', '重试']), 'and the refresh shows 继续 again');

            // While an older version is on screen, a refresh does not offer it
            await quietly(() => botMessageService.switchVersion(switchContext, run.firstMessageId, 'prev'));
            botTelegram.reset();
            await quietly(() =>
                bot.handleUpdate(callbackUpdate({ chatId: run.chatId, messageId: run.firstMessageId, userId: USER_ID, data: 'resp:rewind' }))
            );
            expect(json(finalButtonsOf(botTelegram)) === json(['重试', '>']), `nor on the older version (got ${json(finalButtonsOf(botTelegram))})`);

            const app = new Hono<PanelEnv>();
            registerHealthRoute(app, { startedAt: new Date(), version: 'offline' });
            const health: unknown = await (await app.request('/api/health')).json();
            const reported = isRecord(health) ? health.resumableReplies : undefined;
            expect(
                typeof reported === 'number' && reported === state.countResumableReplies() && reported > 0,
                `/api/health reports the resumable replies (got ${json(reported)})`
            );
        },
    },
    {
        name: 'the edit redraw puts 继续 in front of the edit button while the shown version is marked',
        body: async () => {
            const chatId = takeChatId();
            const { bot, telegram } = createFakeBot();
            autoUpdate(bot);
            const seed = async (marked: boolean): Promise<number> => {
                const userMessageId = takeMessageId();
                const firstMessageId = takeMessageId();
                await dbIndex.saveMessage({ chatId, messageId: userMessageId, userId: USER_ID, date: new Date(), userName: 'u', message: '原文' });
                await dbIndex.BotResponse.create({
                    messageId: firstMessageId,
                    chatId,
                    userMessageId,
                    currentVersionIndex: 0,
                    versions: JSON.stringify([
                        { versionId: 1, createdAt: new Date().toISOString(), messageIds: [firstMessageId], currentMessageId: firstMessageId, text: '回答', wasStoppedByUser: false },
                    ]),
                    buttonState: dbIndex.ButtonState.NONE,
                    metadata: JSON.stringify({ model: MODEL, hasImage: false }),
                });
                if (marked) state.markReplyResumable(chatId, firstMessageId, { versionId: 1, expiresAt: Date.now() + 60_000 });
                return userMessageId;
            };
            const edit = async (userMessageId: number): Promise<void> => {
                telegram.reset();
                await quietly(() =>
                    bot.handleUpdate({
                        update_id: takeMessageId(),
                        edited_message: {
                            message_id: userMessageId,
                            date: Math.floor(Date.now() / 1000) - 10,
                            edit_date: Math.floor(Date.now() / 1000),
                            chat: { id: chatId, type: 'supergroup', title: '测试群' },
                            from: { id: USER_ID, is_bot: false, first_name: 'u' },
                            text: '改过的原文',
                        },
                    })
                );
                await waitUntil('the edit redraw', () => telegram.callsOf('editMessageReplyMarkup').length > 0);
            };
            await edit(await seed(true));
            expect(
                json(finalButtonsOf(telegram)) === json(['继续', '检测到用户编辑，是否重试']),
                `a marked reply keeps 继续 next to the edit offer (got ${json(finalButtonsOf(telegram))})`
            );
            await edit(await seed(false));
            expect(json(finalButtonsOf(telegram)) === json(['检测到用户编辑，是否重试']), 'an unmarked one shows the edit offer alone');
        },
    },
    {
        name: 'case 15: a checkpoint too big to keep alone: no 继续, no line, no checkpointRounds, the tool usage still counted',
        body: async () => {
            const run = await runReply(takeChatId(), [
                ...keptRounds(2, { state: { blob: Buffer.alloc(64 * 1024 * 1024 + 1024) } }),
                { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') },
            ]);
            expect(json(finalButtonsOf(run.telegram)) === json(['重试']), `only 重试 (got ${describe(run)})`);
            expect(!lastEditTextOf(run.telegram).includes('已保留'), 'no kept rounds line');
            const [row] = await rowsOf(run);
            expect(
                row?.checkpointRounds === null && row.toolCalls === 3 && markOf(run) === undefined && entryOf(run) === undefined,
                `not recorded as kept, but the tools are counted (got ${json({ checkpointRounds: row?.checkpointRounds, toolCalls: row?.toolCalls })})`
            );
        },
    },
    {
        name: 'a kept entry holds none of the attempt: no session, chat context, stream, signal, Bot API or client',
        body: async () => {
            sessionsSeen.length = 0;
            const run = await runReply(takeChatId(), [...keptRounds(2), { fail: new Error('got status: 429 RESOURCE_EXHAUSTED') }]);
            const entry = entryOf(run);
            const session = sessionsSeen.at(-1);
            if (entry === undefined || session === undefined) throw new Error('nothing kept or no session seen');
            const forbidden = new Set<unknown>([session, session.streamController, session.streamController.signal, session.api, session.editor, session.metrics]);
            const problems: string[] = [];
            const seen = new Set<object>();
            const pending: Array<{ value: unknown; path: string }> = [{ value: entry, path: 'entry' }];
            while (pending.length > 0) {
                const next = pending.pop();
                if (next === undefined) break;
                const { value, path } = next;
                if (typeof value !== 'object' || value === null || seen.has(value)) continue;
                seen.add(value);
                if (forbidden.has(value)) problems.push(`${path} is a live object of the attempt`);
                if (value instanceof AbortSignal || value instanceof Api || value instanceof Context) problems.push(`${path} is ${value.constructor.name}`);
                if (Symbol.asyncIterator in value) problems.push(`${path} is a stream`);
                if ('streamController' in value || 'editor' in value || 'typing' in value) problems.push(`${path} looks like a session or chat context`);
                if ('definitions' in value && 'execute' in value) problems.push(`${path} is a tool set (its handlers hold the signal and api)`);
                if (Buffer.isBuffer(value)) continue;
                const children: Array<[string, unknown]> =
                    value instanceof Map
                        ? [...value].map(([key, item]) => [String(key), item])
                        : value instanceof Set
                          ? [...value].map((item, index) => [String(index), item])
                          : Object.entries(value);
                for (const [key, item] of children) pending.push({ value: item, path: `${path}.${key}` });
            }
            expect(problems.length === 0, `nothing of the attempt is referenced (got ${json(problems.slice(0, 5))})`);
            expect(seen.size > 10, `the walk went through the entry (saw ${seen.size} objects)`);
        },
    },
    {
        name: 'finalizing a retry that replaced a media-only version clears the first message in-flight mark too',
        body: async () => {
            const chatId = takeChatId();
            const userMessageId = takeMessageId();
            const firstMessageId = takeMessageId();
            await dbIndex.saveMessage({ chatId, messageId: userMessageId, userId: USER_ID, date: new Date(), userName: 'u', message: '画一只猫' });
            await dbIndex.BotResponse.create({
                messageId: firstMessageId,
                chatId,
                userMessageId,
                currentVersionIndex: 0,
                versions: JSON.stringify([
                    {
                        versionId: 1,
                        createdAt: new Date().toISOString(),
                        messageIds: [firstMessageId],
                        currentMessageId: firstMessageId,
                        text: '',
                        imageBase64: PNG_BYTES.toString('base64'),
                        wasStoppedByUser: false,
                    },
                ]),
                buttonState: dbIndex.ButtonState.RETRY_ONLY,
                metadata: JSON.stringify({ model: MODEL, hasImage: true }),
            });
            const telegram = createFakeTelegram();
            const ctx = contextOf(callbackUpdate({ chatId, messageId: firstMessageId, userId: USER_ID, data: 'resp:retry' }), telegram);
            const session = await quietly(() => botMessageService.startRetry(ctx, firstMessageId));
            if (session === null) throw new Error('no retry session');
            expect(
                session.firstMessageId === firstMessageId && !session.messageIds.includes(firstMessageId),
                'the media-only first message was replaced by a new processing message'
            );
            expect(state.isBotReplyInFlight(chatId, firstMessageId), 'the first message is marked in flight');
            await quietly(() => session.finalize({}));
            expect(!state.isBotReplyInFlight(chatId, firstMessageId), 'the finalization clears that mark');
            expect(session.messageIds.every((messageId) => !state.isBotReplyInFlight(chatId, messageId)), 'and the new messages');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
endOpenReplies();
reportResults(results);
