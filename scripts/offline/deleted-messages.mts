/**
 * Deleted-message surfaces (design 2026-1118-0149, section 五/7.1.3):
 *
 * - luoxu is the only source of deletions; the watcher polls its list and marks
 *   `telegram_messages.deletedAt`, idempotently and without touching replies on
 *   failure;
 * - context building adds exactly one `[deleted]` marker (user header / bot
 *   label) and changes nothing else;
 * - a dry run reads the stored mark and never calls luoxu;
 * - the history tools mark the same fact in their text (`（已删除）`);
 * - the column migration revives the column on a database that predates it.
 *
 * Run: npx tsx scripts/offline/deleted-messages.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { startStubServer } from './support/stub-server.mts';
import type { ModelCapabilities, UnifiedMessage } from '../../src/ai/types.js';

const luoxu = await startStubServer();
process.env.LUOXU_PREVIEW_URL = luoxu.url;
delete process.env.LUOXU_OCR_URL;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

const db = await setupOfflineDb();
const { Message } = db;
const { buildContext } = await import('../../src/reply/context-builder.js');
const { pollDeletedMessagesOnce, resetDeletedMessageWatch } = await import('../../src/services/luoxu-deleted-service.js');
const { fromLuoxuChannelId } = await import('../../src/services/luoxu-channel-id.js');
const { annotationsOf } = await import('../../src/reply/tools/history-text.js');
const { createHistoryState } = await import('../../src/reply/tools/history-state.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { sequelize } = await import('../../src/db/config.js');
const { QueryTypes } = await import('@sequelize/core');

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: false,
};

/** luoxu channel id used by every case; the bot chat id is its mapping */
const CHANNEL = 1415974153;
const CHAT = fromLuoxuChannelId(CHANNEL);

const seedMessage = async (options: {
    chatId?: number;
    text: string | null;
    fromBotSelf?: boolean;
    replyToId?: number | null;
    deletedAt?: Date | null;
}): Promise<number> => {
    const chatId = options.chatId ?? CHAT;
    const messageId = takeMessageId();
    await Message.create({
        chatId,
        messageId,
        fromBotSelf: options.fromBotSelf ?? false,
        userId: options.fromBotSelf === true ? 7777 : 42,
        date: new Date(messageId * 1000),
        userName: options.fromBotSelf === true ? 'Bot' : 'tester',
        text: options.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: options.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
        deletedAt: options.deletedAt ?? null,
    });
    return messageId;
};

const rowOf = async (messageId: number) => {
    const row = await Message.findOne({ where: { chatId: CHAT, messageId } });
    if (!row) throw new Error(`message ${messageId} not found`);
    return row;
};

const textOf = (message: UnifiedMessage): string =>
    message.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');

/** A stub that answers `/deleted` with `pages` in order and counts requests */
const servePages = (pages: readonly unknown[]): { requests: string[] } => {
    const requests: string[] = [];
    luoxu.handle((request, response) => {
        requests.push(request.url ?? '');
        const page = pages[Math.min(requests.length - 1, pages.length - 1)];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(page));
    });
    return { requests };
};

const build = async (trigger: number, options: { dryRun?: boolean } = {}): Promise<UnifiedMessage[]> => {
    const row = await rowOf(trigger);
    const { messages } = await buildContext(row, {
        capabilities: VISION,
        model: 'gemini-3.8-flash',
        ...(options.dryRun === true ? { dryRun: true } : {}),
    });
    return messages;
};

const results: CaseResult[] = [];

results.push(
    await runCase('the deletion watcher marks the rows luoxu reports, idempotently', async () => {
        resetDeletedMessageWatch();
        const first = await seedMessage({ text: 'watch me' });
        const second = await seedMessage({ text: 'and me' });
        const deletionTime = 1_800_000_000;
        const { requests } = servePages([
            {
                deleted: [
                    { g: CHANNEL, id: first, t: deletionTime },
                    { g: CHANNEL, id: second, t: deletionTime + 5 },
                ],
                has_more: false,
            },
        ]);

        await pollDeletedMessagesOnce(0);
        expect(requests.length === 1, `one request (got ${requests.length}: ${requests.join(',')})`);
        expect(requests[0]?.includes('since=0') === true, 'the explicit cursor is sent');
        expect((await rowOf(first)).deletedAt?.getTime() === deletionTime * 1000, 'first row marked with luoxu time');
        expect((await rowOf(second)).deletedAt?.getTime() === (deletionTime + 5) * 1000, 'second row has its own time');

        // A second read of the same window must not move an existing mark
        await pollDeletedMessagesOnce(0);
        expect((await rowOf(first)).deletedAt?.getTime() === deletionTime * 1000, 'mark is not overwritten');
    })
);

results.push(
    await runCase('a paged response is walked to the end and advances the cursor', async () => {
        resetDeletedMessageWatch();
        const first = await seedMessage({ text: 'page one' });
        const second = await seedMessage({ text: 'page two' });
        const { requests } = servePages([
            { deleted: [{ g: CHANNEL, id: first, t: 1_800_000_100 }], has_more: true },
            { deleted: [{ g: CHANNEL, id: second, t: 1_800_000_200 }], has_more: false },
        ]);

        const cursor = await pollDeletedMessagesOnce(0);
        expect(requests.length === 2, `two pages requested (got ${requests.length})`);
        expect(requests[1]?.includes('since=1800000100') === true, `second page starts at the first page's newest time (got ${requests[1]})`);
        expect(cursor === 1_800_000_200, `cursor is the newest time (got ${cursor})`);
        expect((await rowOf(second)).deletedAt !== null, 'both rows are marked');
    })
);

results.push(
    await runCase('without a cursor the watcher resumes after the newest stored mark', async () => {
        resetDeletedMessageWatch();
        // Later than every mark another case wrote, so the maximum is known
        const resumedAt = 1_810_000_000;
        await seedMessage({ text: 'marked earlier', deletedAt: new Date(resumedAt * 1000) });
        const requests: string[] = [];
        luoxu.handle((request, response) => {
            requests.push(request.url ?? '');
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deleted: [], has_more: false }));
        });

        await pollDeletedMessagesOnce();
        expect(requests.length === 1, 'one request');
        expect(
            requests[0]?.includes(`since=${resumedAt}&`) === true,
            `the cursor is the stored mark in unix seconds (got ${requests[0]})`
        );
    })
);

results.push(
    await runCase('with no stored mark the watcher starts at the retention window', async () => {
        resetDeletedMessageWatch();
        await Message.update({ deletedAt: null }, { where: {} });
        const requests: string[] = [];
        luoxu.handle((request, response) => {
            requests.push(request.url ?? '');
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deleted: [], has_more: false }));
        });

        await pollDeletedMessagesOnce();
        const since = Number(new URL(requests[0] ?? 'http://x/', 'http://x/').searchParams.get('since'));
        const expected = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
        expect(Number.isFinite(since), `a numeric cursor was sent (request: ${requests[0]})`);
        expect(Math.abs(since - expected) < 120, `cursor is ~7 days ago in seconds (got ${since}, expected ~${expected})`);
    })
);

results.push(
    await runCase('an unreachable luoxu changes nothing and does not throw', async () => {
        resetDeletedMessageWatch();
        const messageId = await seedMessage({ text: 'still here' });
        const requests: string[] = [];
        luoxu.handle((_request, response) => {
            requests.push(_request.url ?? '');
            response.writeHead(500, { 'Content-Type': 'text/plain' });
            response.end('boom');
        });

        await pollDeletedMessagesOnce(0);
        expect(requests.length === 1, 'the watcher tried once');
        expect((await rowOf(messageId)).deletedAt === null, 'no mark on failure');
    })
);

results.push(
    await runCase('a malformed luoxu payload is ignored', async () => {
        resetDeletedMessageWatch();
        const messageId = await seedMessage({ text: 'ignore garbage' });
        luoxu.handle((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deleted: 'not-an-array', has_more: false }));
        });

        await pollDeletedMessagesOnce(0);
        expect((await rowOf(messageId)).deletedAt === null, 'no mark from a malformed payload');
    })
);

results.push(
    await runCase('without LUOXU_PREVIEW_URL the watcher is a no-op', async () => {
        resetDeletedMessageWatch();
        const messageId = await seedMessage({ text: 'no luoxu configured' });
        let requests = 0;
        luoxu.handle((_request, response) => {
            requests += 1;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deleted: [], has_more: false }));
        });
        const configured = process.env.LUOXU_PREVIEW_URL;
        delete process.env.LUOXU_PREVIEW_URL;
        try {
            await pollDeletedMessagesOnce(0);
        } finally {
            process.env.LUOXU_PREVIEW_URL = configured;
        }
        expect(requests === 0, `no request while unconfigured (got ${requests})`);
        expect((await rowOf(messageId)).deletedAt === null, 'nothing marked');
    })
);

results.push(
    await runCase('a deleted user message gets one [deleted] marker; content is unchanged', async () => {
        const deletedAt = new Date('2026-11-17T13:00:00Z');
        const marked = await seedMessage({ text: '这是被删除的正文', deletedAt });
        const trigger = await seedMessage({ text: '总结一下', replyToId: marked });
        const messages = await build(trigger);
        const all = messages.map(textOf).join('\n');

        expect(all.includes('[deleted]'), `the header carries the marker (${all})`);
        expect(all.includes('这是被删除的正文'), 'the deleted message keeps its body');
        const deletedTurns = messages.filter((message) => textOf(message).includes('[deleted]'));
        expect(deletedTurns.length === 1, `exactly one turn carries the marker (got ${deletedTurns.length})`);
        expect(
            deletedTurns[0]?.content.some((part) => part.type === 'text' && part.text?.includes('这是被删除的正文')) === true,
            'the marked turn is the message itself'
        );
    })
);

results.push(
    await runCase('a deleted bot reply is marked on its [ #N ] label line', async () => {
        const deletedAt = new Date('2026-11-17T13:10:00Z');
        const botMessage = await seedMessage({ text: '我说过的话', fromBotSelf: true, deletedAt });
        const userTrigger = await seedMessage({ text: '继续', replyToId: botMessage });
        const messages = await build(userTrigger);
        const all = messages.map(textOf).join('\n');

        expect(all.includes('[deleted]'), `the bot turn is marked (${all})`);
        expect(/\[#\d+\] \[deleted\]/.test(all), 'the marker rides right after the label');
        expect(all.includes('我说过的话'), 'the deleted reply keeps its text');
    })
);

results.push(
    await runCase('the panel dry run reads the stored mark and never calls luoxu', async () => {
        resetDeletedMessageWatch();
        const deletedAt = new Date('2026-11-17T13:20:00Z');
        const marked = await seedMessage({ text: '面板里也该看到', deletedAt });
        const trigger = await seedMessage({ text: '看一下', replyToId: marked });
        let requests = 0;
        luoxu.handle((_request, response) => {
            requests += 1;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deleted: [], has_more: false }));
        });

        const messages = await build(trigger, { dryRun: true });
        expect(requests === 0, `dry run made no request (got ${requests})`);
        expect(messages.map(textOf).join('\n').includes('[deleted]'), 'a stored mark still shows in the dry run');
    })
);

results.push(
    await runCase('the history tools mark deleted hits and keep the mark when the entry grows', async () => {
        const state = createHistoryState();
        const entry = state.remember({
            channelId: CHANNEL,
            messageId: 900001,
            timestamp: 1_800_000_000,
            fromId: 42,
            fromName: 'tester',
            fromIsBot: false,
            indexedHtml: 'deleted words',
            deletedAt: 1_800_000_500,
        });
        expect(annotationsOf(entry).includes('（已删除）'), 'the annotation line carries the deletion mark');
        const grown = state.remember({
            channelId: CHANNEL,
            messageId: 900001,
            timestamp: 1_800_000_000,
            fromId: 42,
            fromName: 'tester',
            fromIsBot: false,
            indexedHtml: 'deleted words',
            rawText: 'deleted words',
        });
        expect(grown.deletedAt === 1_800_000_500, 'a later read without the field keeps the known mark');
        const alive = state.remember({
            channelId: CHANNEL,
            messageId: 900002,
            timestamp: 1_800_000_000,
            fromId: 42,
            fromName: 'tester',
            fromIsBot: false,
            indexedHtml: 'alive words',
        });
        expect(annotationsOf(alive).includes('已删除') === false, 'a message without the mark reads unchanged');
    })
);

results.push(
    await runCase('the column migration adds deletedAt to a database that predates it', async () => {
        const columnsOf = async (): Promise<Set<string>> => {
            const columns = await sequelize.query<{ name: string }>(
                'PRAGMA table_info(telegram_messages)',
                { type: QueryTypes.SELECT }
            );
            return new Set(columns.map((column) => column.name));
        };
        expect(await columnsOf().then((columns) => columns.has('deletedAt')), 'the column exists after the normal startup');
        await sequelize.query('ALTER TABLE telegram_messages DROP COLUMN deletedAt');
        expect((await columnsOf()).has('deletedAt') === false, 'simulated old database without the column');
        await runSchemaMigrations();
        expect((await columnsOf()).has('deletedAt'), 'the migration restores the column');
    })
);

await luoxu.close();
await reportResults(results);
