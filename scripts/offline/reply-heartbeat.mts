/**
 * Offline cases for the heartbeat of a reply being generated (design §7.1):
 * every chunk, a status line included, can renew the reply's in-flight marks
 * and move its bot_responses row forward, at most once a minute and never
 * after the reply was finalized. The row is written in the format Sequelize
 * itself writes, and the release check's age parser reads it as recent.
 *
 * The minute is crossed with a shifted Date.now (processStream) or an injected
 * clock (the heartbeat itself); the row's own timestamps stay real.
 *
 * Run: npx tsx scripts/offline/reply-heartbeat.mts
 */
import { QueryTypes } from '@sequelize/core';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { contextOf, createFakeTelegram, endOpenReplies, messageUpdate, quietly, trackReply } from './fake-telegram.mts';
import { ageSecondsOf } from '../deploy/reply-age.mts';
import type { StreamChunk } from '../../src/ai/types.js';

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const { touchProcessingBotResponse } = await import('../../src/db/queries/bot-response-heartbeat.js');
const state = await import('../../src/state.js');

type ChatContext = import('../../src/reply/response-handler.js').ChatContext;

const USER_ID = 5150;
const MINUTE_MS = 60_000;
/** The real clock, kept before any case shifts Date.now */
const realNow = Date.now;
const json = (value: unknown): string => JSON.stringify(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A chat context exactly as a trigger message creates it */
const startReply = async (chatId: number): Promise<ChatContext> => {
    const telegram = createFakeTelegram();
    const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: USER_ID, text: '你好' }), telegram);
    const chatContext = await quietly(() => responseHandler.createChatContext(ctx, { model: 'deepseek-flash' }));
    if (!chatContext) throw new Error('no chat context');
    return trackReply(chatContext);
};

interface StoredRow {
    updatedAt: string;
    createdAt: string;
    buttonState: string;
    versions: string;
    metadata: string;
}

const isStoredRow = (value: unknown): value is StoredRow =>
    typeof value === 'object' &&
    value !== null &&
    ['updatedAt', 'createdAt', 'buttonState', 'versions', 'metadata'].every(
        (column) => typeof Reflect.get(value, column) === 'string'
    );

/** The row as the database holds it: raw strings, not what the model makes of them */
const rowOf = async (chatId: number, firstMessageId: number): Promise<StoredRow> => {
    const rows = await sequelize.query(
        'SELECT updatedAt, createdAt, buttonState, versions, metadata FROM bot_responses WHERE chatId = :chatId AND messageId = :messageId',
        { type: QueryTypes.SELECT, replacements: { chatId, messageId: firstMessageId } }
    );
    const [row] = rows;
    if (!isStoredRow(row)) throw new Error(`no bot_responses row for ${chatId}:${firstMessageId} (got ${json(rows)})`);
    return row;
};

/** Wait for the heartbeat's unawaited write to land */
const waitForRow = async (
    chatId: number,
    firstMessageId: number,
    condition: (row: StoredRow) => boolean
): Promise<StoredRow> => {
    const deadline = realNow() + 3000;
    for (;;) {
        const row = await rowOf(chatId, firstMessageId);
        if (condition(row)) return row;
        if (realNow() > deadline) throw new Error(`the row never changed (still ${json(row)})`);
        await sleep(20);
    }
};

/** Digits blanked out: two timestamps in the same format have the same shape */
const shapeOf = (timestamp: string): string => timestamp.replace(/\d/g, '0');

const isRecent = (row: StoredRow): boolean => ageSecondsOf(row.updatedAt, realNow()) < 10;

/** Run `body` while Date.now runs ahead of the real clock by what `advance` added */
const withShiftedClock = async <T,>(body: (advance: (ms: number) => void) => Promise<T>): Promise<T> => {
    let shiftMs = 0;
    Date.now = () => realNow() + shiftMs;
    try {
        return await body((ms) => {
            shiftMs += ms;
        });
    } finally {
        Date.now = realNow;
    }
};

const inFlightKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

/** Make the reply's marks look as old as a reply that started 9.5 minutes ago */
const ageMarks = (chatContext: ChatContext, botMessageIds: readonly number[], at: number): void => {
    const { repliesInFlight, botRepliesInFlight } = state.getAppState();
    repliesInFlight.set(inFlightKey(chatContext.chatId, chatContext.userMessageId), at);
    for (const messageId of botMessageIds) botRepliesInFlight.set(inFlightKey(chatContext.chatId, messageId), at);
};

const marksOf = (chatContext: ChatContext, botMessageIds: readonly number[]): Array<number | undefined> => {
    const { repliesInFlight, botRepliesInFlight } = state.getAppState();
    return [
        repliesInFlight.get(inFlightKey(chatContext.chatId, chatContext.userMessageId)),
        ...botMessageIds.map((messageId) => botRepliesInFlight.get(inFlightKey(chatContext.chatId, messageId))),
    ];
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'a chunk past the minute renews the marks and moves the row forward in the model’s own format',
        body: async () => {
            const chatId = -1007100000001;
            const chatContext = await startReply(chatId);
            const { session } = chatContext;
            const firstMessageId = session.firstMessageId;
            // A continuation the reply already opened is renewed as well
            const continuationId = takeMessageId();
            session.messageIds.push(continuationId);
            const botMessageIds = [firstMessageId, continuationId];

            const modelWritten = await rowOf(chatId, firstMessageId);
            await touchProcessingBotResponse(chatId, firstMessageId, new Date(realNow() - 20 * MINUTE_MS));
            const aged = await rowOf(chatId, firstMessageId);
            expect(
                ageSecondsOf(aged.updatedAt, realNow()) >= 20 * 60 - 1,
                `the row starts 20 minutes old (got ${aged.updatedAt})`
            );

            let beforeTheMinute: Array<number | undefined> = [];
            let afterTheMinute: Array<number | undefined> = [];
            let beatAt = 0;
            let touched: StoredRow | undefined;
            await withShiftedClock(async (advance) => {
                const stale = Date.now() - 9.5 * MINUTE_MS;
                ageMarks(chatContext, botMessageIds, stale);
                async function* stream(): AsyncGenerator<StreamChunk> {
                    yield { type: 'thinking', content: '先想一想' };
                    advance(30_000);
                    yield { type: 'status', status: { text: '⚙ 正在搜索', chatAction: 'typing' } };
                    beforeTheMinute = marksOf(chatContext, botMessageIds);
                    advance(31_000);
                    beatAt = Date.now();
                    // Only a status chunk crosses the minute: it counts too
                    yield { type: 'status' };
                    afterTheMinute = marksOf(chatContext, botMessageIds);
                    touched = await waitForRow(chatId, firstMessageId, isRecent);
                    yield { type: 'text', content: '答案' };
                    yield { type: 'done' };
                }
                await quietly(async () => {
                    const response = await responseHandler.processStream(stream(), chatContext, 0);
                    await responseHandler.sendFinalResponse(chatContext, response);
                });
                expect(
                    beforeTheMinute.every((mark) => mark === stale),
                    `nothing is renewed within the minute (got ${json(beforeTheMinute)})`
                );
            });

            expect(
                afterTheMinute.length === 3 && afterTheMinute.every((mark) => mark !== undefined && mark >= beatAt),
                `the trigger, the first message and the continuation are marked again (got ${json(afterTheMinute)}, beat at ${beatAt})`
            );
            if (touched === undefined) throw new Error('the heartbeat row was not read');
            expect(
                ageSecondsOf(touched.updatedAt, realNow()) >= 0 && ageSecondsOf(touched.updatedAt, realNow()) < 10,
                `the release check reads the row as seconds old (got ${touched.updatedAt})`
            );
            expect(
                shapeOf(touched.updatedAt) === shapeOf(modelWritten.updatedAt) && touched.updatedAt.endsWith(' +00:00'),
                `in the format the model writes (got ${touched.updatedAt}, the model wrote ${modelWritten.updatedAt})`
            );
            expect(
                touched.createdAt === aged.createdAt &&
                    touched.buttonState === 'processing' &&
                    touched.versions === aged.versions &&
                    touched.metadata === aged.metadata,
                `only updatedAt changed (got ${json({ before: aged, after: touched })})`
            );
            expect(
                !state.isBotReplyInFlight(chatId, firstMessageId) &&
                    !state.isBotReplyInFlight(chatId, continuationId) &&
                    !state.getRepliesInFlight(chatId).includes(chatContext.userMessageId),
                'the finalize still takes every mark off'
            );
        },
    },
    {
        name: 'a chunk after the finalize renews nothing and leaves the finished row alone',
        body: async () => {
            const chatId = -1007100000002;
            const chatContext = await startReply(chatId);
            const { session } = chatContext;
            const firstMessageId = session.firstMessageId;

            let finalized: StoredRow | undefined;
            await withShiftedClock(async (advance) => {
                async function* stream(): AsyncGenerator<StreamChunk> {
                    yield { type: 'text', content: '答到一半' };
                    // Another path finished the reply while the stream still delivers
                    await session.finalize();
                    finalized = await rowOf(chatId, firstMessageId);
                    advance(2 * MINUTE_MS);
                    yield { type: 'status', status: { text: '⚙ 正在搜索', chatAction: 'typing' } };
                    yield { type: 'done' };
                }
                await quietly(() => responseHandler.processStream(stream(), chatContext, 0));
            });
            // Room for a write that should not have been started
            await sleep(100);

            expect(
                !state.isBotReplyInFlight(chatId, firstMessageId) &&
                    !state.getRepliesInFlight(chatId).includes(chatContext.userMessageId),
                'the finished reply is not marked as generating again'
            );
            const after = await rowOf(chatId, firstMessageId);
            expect(
                finalized !== undefined && finalized.buttonState !== 'processing' && after.updatedAt === finalized.updatedAt,
                `the finished row keeps its time (got ${json({ finalized, after })})`
            );

            // The statement itself refuses a row that is no longer processing
            const changed = await touchProcessingBotResponse(chatId, firstMessageId, new Date(realNow() + MINUTE_MS));
            const untouched = await rowOf(chatId, firstMessageId);
            expect(
                changed === 0 && untouched.updatedAt === after.updatedAt,
                `no row changes (got ${changed}, ${untouched.updatedAt})`
            );
        },
    },
    {
        name: 'the heartbeat beats once a minute, counted from its last beat',
        body: async () => {
            const chatId = -1007100000003;
            const chatContext = await startReply(chatId);
            const firstMessageId = chatContext.session.firstMessageId;
            let clock = 1_000_000;
            const beat = responseHandler.createReplyHeartbeat(chatContext.session, () => clock);
            const marks = (): Array<number | undefined> => marksOf(chatContext, [firstMessageId]);
            const SENTINEL = 1;

            ageMarks(chatContext, [firstMessageId], SENTINEL);
            clock += responseHandler.REPLY_HEARTBEAT_INTERVAL_MS;
            beat();
            expect(marks().every((mark) => mark === SENTINEL), 'exactly one interval later: not yet');

            clock += 1;
            beat();
            expect(marks().every((mark) => mark !== undefined && mark > SENTINEL), 'past the interval: renewed');

            ageMarks(chatContext, [firstMessageId], SENTINEL);
            clock += 30_000;
            beat();
            expect(marks().every((mark) => mark === SENTINEL), 'half a minute after the last beat: not yet');

            clock += 31_000;
            beat();
            expect(marks().every((mark) => mark !== undefined && mark > SENTINEL), 'a minute after the last beat: renewed');
            await waitForRow(chatId, firstMessageId, isRecent);
            await quietly(() => chatContext.session.finalize());
        },
    },
    {
        name: 'a failed row update only logs; the marks are renewed all the same',
        body: async () => {
            const chatId = -1007100000004;
            const chatContext = await startReply(chatId);
            const firstMessageId = chatContext.session.firstMessageId;
            let clock = 2_000_000;
            const beat = responseHandler.createReplyHeartbeat(chatContext.session, () => clock);

            const warnings: string[] = [];
            const originalWarn = console.warn;
            console.warn = (...args: unknown[]): void => {
                warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
            };
            await sequelize.query('ALTER TABLE bot_responses RENAME TO bot_responses_parked');
            try {
                ageMarks(chatContext, [firstMessageId], 1);
                clock += 2 * MINUTE_MS;
                // Never throws: the write is not awaited
                beat();
                expect(
                    marksOf(chatContext, [firstMessageId]).every((mark) => mark !== undefined && mark > 1),
                    'the marks are renewed without waiting for the row'
                );
                const deadline = realNow() + 3000;
                while (!warnings.some((line) => line.includes('heartbeat')) && realNow() < deadline) await sleep(20);
            } finally {
                await sequelize.query('ALTER TABLE bot_responses_parked RENAME TO bot_responses');
                console.warn = originalWarn;
            }
            expect(
                warnings.some((line) => line.includes('[response-handler] heartbeat could not touch the reply row')),
                `the failure is logged (got ${json(warnings)})`
            );
            await quietly(() => chatContext.session.finalize());
        },
    },
    {
        name: 'the release check’s age parser reads the stored format, and nothing else',
        body: async () => {
            const now = Date.parse('2026-11-11T07:30:06.000Z');
            expect(ageSecondsOf('2026-11-11 07:29:06.000 +00:00', now) === 60, 'a stored UTC time a minute ago');
            expect(ageSecondsOf('2026-11-11 15:29:06.000 +08:00', now) === 60, 'the zone is honoured');
            expect(ageSecondsOf('not a time', now) === 0 && ageSecondsOf(null, now) === 0, 'unreadable: 0');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
endOpenReplies();
await sequelize.close();
reportResults(results);
