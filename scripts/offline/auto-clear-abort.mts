/**
 * Offline cases for graceful shutdown abort of the hourly cleanup sweep
 * (`clearExpiredData(signal)` and `stopAutoClear()`).
 *
 * Run: pnpm test:offline auto-clear-abort
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

const db = await setupOfflineDb();
const { Message } = db;
const { WorkspaceFile } = await import('../../src/db/workspaceFileDTO.js');
const { autoClear, clearExpiredData, stopAutoClear } = await import('../../src/ingest/auto-save.js');

const EXPIRED_DATE = new Date('2020-01-01T00:00:00.000Z');

const seedExpiredMessages = async (count: number): Promise<number[]> => {
    const ids: number[] = [];
    for (let index = 0; index < count; index += 1) {
        const messageId = takeMessageId();
        await Message.create({
            chatId: OFFLINE_CHAT_ID,
            messageId,
            fromBotSelf: false,
            date: EXPIRED_DATE,
            userName: 'tester',
            text: `expired-${index}`,
            quoteText: null,
            file: null,
            fileMime: null,
            fileUniqueId: null,
            replyToId: null,
            chatCommand: null,
            modelParts: null,
            mediaHint: null,
            messageKind: null,
            messageDetail: null,
            forwardOrigin: null,
            forwardFromId: null,
            viaBot: null,
            ocrText: null,
        });
        ids.push(messageId);
    }
    return ids;
};

const seedExpiredWorkspaceFile = async (path: string): Promise<number> => {
    const content = Buffer.from('stale draft');
    const row = await WorkspaceFile.create({
        chatId: OFFLINE_CHAT_ID,
        conversationRootId: takeMessageId(),
        path,
        content,
        sizeBytes: content.length,
        lastUsedAt: EXPIRED_DATE,
    });
    return row.id;
};

const results: CaseResult[] = [];

results.push(
    await runCase('pre-aborted signal returns cleanly without deleting expired rows', async () => {
        const messageIds = await seedExpiredMessages(3);
        const workspaceId = await seedExpiredWorkspaceFile('abort-pre-token');
        const controller = new AbortController();
        controller.abort();

        await clearExpiredData(controller.signal);

        const remainingMessages = await Message.count({
            where: { chatId: OFFLINE_CHAT_ID, messageId: messageIds },
        });
        const remainingWorkspace = await WorkspaceFile.findByPk(workspaceId);
        expect(
            remainingMessages === messageIds.length,
            `all ${messageIds.length} expired messages survive pre-aborted sweep (remaining=${remainingMessages})`
        );
        expect(
            remainingWorkspace !== null,
            'expired workspace file survives pre-aborted sweep'
        );

        await Message.destroy({ where: { chatId: OFFLINE_CHAT_ID, messageId: messageIds } });
        await WorkspaceFile.destroy({ where: { id: workspaceId } });
    })
);

results.push(
    await runCase('mid-sweep abort stops between message batches and skips later phases', async () => {
        // 120 expired messages span 3 batches (CLEANUP_BATCH_SIZE = 50)
        const messageIds = await seedExpiredMessages(120);
        const workspaceId = await seedExpiredWorkspaceFile('abort-mid-token');
        const controller = new AbortController();

        const hookName = 'offline-abort-after-first-batch';
        let destroyCalls = 0;
        Message.hooks.addListener('afterBulkDestroy', () => {
            destroyCalls += 1;
            if (destroyCalls === 1) {
                controller.abort();
            }
        }, hookName);

        try {
            await clearExpiredData(controller.signal);
        } finally {
            Message.hooks.removeListener('afterBulkDestroy', hookName);
        }

        const remainingMessages = await Message.count({
            where: { chatId: OFFLINE_CHAT_ID, messageId: messageIds },
        });
        const remainingWorkspace = await WorkspaceFile.findByPk(workspaceId);
        expect(
            destroyCalls === 1,
            `aborted after first message batch (destroyCalls=${destroyCalls})`
        );
        expect(
            remainingMessages === 70,
            `remaining 70 expired messages were not deleted after abort (remaining=${remainingMessages})`
        );
        expect(
            remainingWorkspace !== null,
            'later workspace cleanup phase was skipped after abort'
        );

        await Message.destroy({ where: { chatId: OFFLINE_CHAT_ID, messageId: messageIds } });
        await WorkspaceFile.destroy({ where: { id: workspaceId } });
    })
);

results.push(
    await runCase('stopAutoClear is idempotent before and after autoClear', async () => {
        // Safe before autoClear() has ever started
        stopAutoClear();
        autoClear();
        // Calling autoClear() again while running is a no-op
        autoClear();
        // Stopping clears the timer and aborts the controller; repeat calls stay safe
        stopAutoClear();
        stopAutoClear();
        expect(true, 'autoClear and stopAutoClear lifecycle completed cleanly');
    })
);

reportResults(results);
