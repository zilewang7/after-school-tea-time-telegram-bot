/**
 * Offline cases for the `message_media` table (v5 unified reply pictures).
 *
 * The table ties a bot reply's pictures to its message row: one row per
 * picture, 1-based delivery order, content-addressed media_cache key. The
 * context builder and the panel read it instead of a version's JSON, and the
 * hourly message cleanup cascades it with the message row.
 *
 * Run: npx tsx scripts/offline/message-media.mts
 */
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

import type { StoredMessageMedia } from '../../src/db/index.js';

const db = await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { clearExpiredData } = await import('../../src/ingest/auto-save.js');
const { MessageMedia } = await import('../../src/db/messageMediaDTO.js');

const CHAT = -1009200000001;

const mediaRow = (ordinal: number, label: string, overrides: Partial<StoredMessageMedia> = {}) => ({
    ordinal,
    mediaKey: `out:sha256:${label.padEnd(64, '0')}`,
    mimeType: 'image/png',
    sizeBytes: 128,
    placement: 'attachment' as const,
    ...overrides,
});

/** A message row with every required column (the suite's Message model has no defaults) */
const seedMessage = async (input: { chatId: number; messageId: number; date: Date; text?: string }): Promise<void> => {
    await db.Message.create({
        chatId: input.chatId,
        messageId: input.messageId,
        fromBotSelf: false,
        userId: 1001,
        date: input.date,
        userName: 'Alice',
        text: input.text ?? null,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'replace writes the pictures in delivery order and lists them back',
        body: async () => {
            const messageId = takeMessageId();
            await dbIndex.replaceMessageMedia(CHAT, messageId, [
                mediaRow(1, 'inline', { placement: 'inline', caption: '图一的图注' }),
                mediaRow(2, 'album-a'),
                mediaRow(3, 'album-b', { caption: '第二张' }),
            ]);
            const listed = await dbIndex.listMessageMedia(CHAT, messageId);
            expect(listed.length === 3, `three pictures (got ${listed.length})`);
            expect(
                listed.map((item) => item.ordinal).join(',') === '1,2,3',
                `ordinals follow delivery order (got ${listed.map((item) => item.ordinal).join(',')})`
            );
            expect(
                listed.map((item) => item.placement).join(',') === 'inline,attachment,attachment',
                'placement survives the roundtrip'
            );
            expect(
                listed[0]?.caption === '图一的图注' && listed[1]?.caption === undefined && listed[2]?.caption === '第二张',
                `captions keep their slots (got ${JSON.stringify(listed.map((item) => item.caption))})`
            );
            expect(
                listed.every((item) => item.mediaKey.startsWith('out:sha256:') && item.mimeType === 'image/png' && item.sizeBytes === 128),
                'the media key and the descriptor fields are stored as given'
            );
        },
    },
    {
        name: 'replaceMessageMedia replaces the whole set (a version switch cannot leave the old one)',
        body: async () => {
            const messageId = takeMessageId();
            await dbIndex.replaceMessageMedia(CHAT, messageId, [mediaRow(1, 'a'), mediaRow(2, 'b'), mediaRow(3, 'c')]);
            await dbIndex.replaceMessageMedia(CHAT, messageId, [mediaRow(1, 'd'), mediaRow(2, 'e')]);
            const two = await dbIndex.listMessageMedia(CHAT, messageId);
            expect(two.length === 2 && two[0]?.ordinal === 1 && two[1]?.ordinal === 2, `the set is replaced (got ${two.length})`);

            await dbIndex.replaceMessageMedia(CHAT, messageId, []);
            expect((await dbIndex.listMessageMedia(CHAT, messageId)).length === 0, 'an empty set clears the rows');

            // A legacy single picture has no content-addressed key: it stays out of this table
            await dbIndex.replaceMessageMedia(CHAT, messageId, [mediaRow(1, 'legacy', { mediaKey: '' })]);
            expect((await dbIndex.listMessageMedia(CHAT, messageId)).length === 0, 'a row without a media key is dropped');
            expect(await MessageMedia.count({ where: { chatId: CHAT, messageId } }) === 0, 'and nothing was inserted');
        },
    },
    {
        name: 'listMessageMediaForMessages batches a context or tree page by message',
        body: async () => {
            const first = takeMessageId();
            const second = takeMessageId();
            const third = takeMessageId();
            await dbIndex.replaceMessageMedia(CHAT, first, [mediaRow(1, 'a'), mediaRow(2, 'b')]);
            await dbIndex.replaceMessageMedia(CHAT, second, [mediaRow(1, 'c')]);
            const byMessageId = await dbIndex.listMessageMediaForMessages(CHAT, [first, second, third]);
            expect(
                byMessageId.get(first)?.length === 2 && byMessageId.get(second)?.length === 1 && !byMessageId.has(third),
                `only messages with pictures appear (got ${[...byMessageId.keys()].join(',')})`
            );
            expect(
                byMessageId.get(first)?.map((item) => item.ordinal).join(',') === '1,2',
                'the batch keeps ordinal order inside a message'
            );
            expect((await dbIndex.listMessageMediaForMessages(CHAT, [])).size === 0, 'an empty id list costs no query');
        },
    },
    {
        name: 'deleteMessageMediaForKeys deletes exactly the given (chat, message) pairs',
        body: async () => {
            const kept = takeMessageId();
            const deleted = takeMessageId();
            await dbIndex.replaceMessageMedia(CHAT, kept, [mediaRow(1, 'keep')]);
            await dbIndex.replaceMessageMedia(CHAT, deleted, [mediaRow(1, 'drop')]);
            const count = await dbIndex.deleteMessageMediaForKeys([
                { chatId: CHAT, messageId: deleted },
                { chatId: CHAT, messageId: deleted },
            ]);
            expect(count === 1, `one row of two messages (got ${count})`);
            expect((await dbIndex.listMessageMedia(CHAT, deleted)).length === 0, 'the named message lost its rows');
            expect((await dbIndex.listMessageMedia(CHAT, kept)).length === 1, 'the other keeps its picture');
        },
    },
    {
        name: 'the hourly cleanup cascades message_media with a stale message row',
        body: async () => {
            const staleChat = -1009200000002;
            const staleMessageId = takeMessageId();
            const freshMessageId = takeMessageId();
            const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
            await seedMessage({ chatId: staleChat, messageId: staleMessageId, date: eightDaysAgo, text: '旧回复' });
            await seedMessage({ chatId: staleChat, messageId: freshMessageId, date: new Date(), text: '新回复' });
            await dbIndex.replaceMessageMedia(staleChat, staleMessageId, [mediaRow(1, 'stale-a'), mediaRow(2, 'stale-b')]);
            await dbIndex.replaceMessageMedia(staleChat, freshMessageId, [mediaRow(1, 'fresh')]);

            await clearExpiredData();

            expect(
                (await dbIndex.listMessageMedia(staleChat, staleMessageId)).length === 0,
                'the stale message took its picture rows with it'
            );
            expect(
                (await dbIndex.listMessageMedia(staleChat, freshMessageId)).length === 1,
                'the fresh message keeps its picture'
            );
            expect(await MessageMedia.count({ where: { chatId: staleChat } }) === 1, 'only the fresh row is left');
        },
    },
    {
        name: 'listMessageMediaForMessages batches a list longer than one SQLite page',
        body: async () => {
            const messageId = takeMessageId();
            await dbIndex.replaceMessageMedia(CHAT, messageId, [mediaRow(1, 'long-a'), mediaRow(2, 'long-b')]);
            // The batch boundary is 500: put the one message with pictures behind it
            const ids = Array.from({ length: 620 }, (_value, index) => 8_000_000 + index);
            ids.push(messageId);
            const byMessageId = await dbIndex.listMessageMediaForMessages(CHAT, ids);
            expect(
                byMessageId.get(messageId)?.length === 2 && byMessageId.size === 1,
                `the picture rows survive the batching (got ${byMessageId.size} messages)`
            );
            expect(
                byMessageId.get(messageId)?.map((item) => item.ordinal).join(',') === '1,2',
                'the ordinal order is kept inside the message'
            );
            // A very long list without pictures reads as empty, not an error
            const many = Array.from({ length: 40_000 }, (_value, index) => 9_000_000 + index);
            expect((await dbIndex.listMessageMediaForMessages(CHAT, many)).size === 0, 'a long picture-less list is empty');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();

reportResults(results);
