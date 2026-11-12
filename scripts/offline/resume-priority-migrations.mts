/**
 * Offline cases for the schema of Gemini resume and Priority PayGo (design
 * §10): reply_metrics gains roundRetries, tierRequested, the four priority
 * sums, resumedRounds and checkpointRounds; chat_settings gains the nullable
 * geminiPriority. A fresh database gets them from the models at sync time and
 * the migrations skip the missing tables; an old database gets them from the
 * migrations, keeps its rows, and takes new rows afterwards. Every other
 * offline file runs on a fresh database, so without these cases a missing
 * migration would only show in production, as metric rows that never write.
 *
 * Run: npx tsx scripts/offline/resume-priority-migrations.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

await setupOfflineDb();
const { QueryTypes } = await import('@sequelize/core');
const { sequelize } = await import('../../src/db/config.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const { findReplyMetricsByReply, insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');
const service = await import('../../src/services/chat-settings-service.js');

type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;

const OWNER = { userId: 4242, isOwner: true };

const REPLY_METRICS_COLUMNS = [
    'roundRetries',
    'tierRequested',
    'priorityRounds',
    'priorityPromptTokens',
    'priorityCachedTokens',
    'priorityOutputTokens',
    'resumedRounds',
    'checkpointRounds',
];

// In name order, as appliedMigrations reads them
const MIGRATION_NAMES = ['20261112_chat_settings_gemini_priority', '20261112_reply_metrics_resume_priority'];

// reply_metrics and chat_settings as they were before this change
const OLD_REPLY_METRICS = `
    CREATE TABLE reply_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chatId INTEGER NOT NULL, userMessageId INTEGER NOT NULL,
        firstMessageId INTEGER NOT NULL, versionId INTEGER NOT NULL, triggerUserId INTEGER DEFAULT NULL,
        model TEXT NOT NULL, platform TEXT NOT NULL, route TEXT DEFAULT NULL, commandType TEXT NOT NULL,
        isRetry INTEGER NOT NULL DEFAULT 0, startedAt TEXT NOT NULL, requestStartedAt TEXT DEFAULT NULL,
        firstChunkAt TEXT DEFAULT NULL, finishedAt TEXT NOT NULL, outcome TEXT NOT NULL,
        errorKind TEXT DEFAULT NULL, errorSummary TEXT DEFAULT NULL, rounds INTEGER DEFAULT NULL,
        toolCalls INTEGER NOT NULL DEFAULT 0, toolFailures INTEGER NOT NULL DEFAULT 0, toolUsage TEXT DEFAULT NULL,
        promptTokens INTEGER DEFAULT NULL, cachedTokens INTEGER DEFAULT NULL, cacheWriteTokens INTEGER DEFAULT NULL,
        outputTokens INTEGER DEFAULT NULL, thoughtsTokens INTEGER DEFAULT NULL, imageOutputTokens INTEGER DEFAULT NULL,
        contextMessages INTEGER DEFAULT NULL, contextImages INTEGER DEFAULT NULL, textChars INTEGER DEFAULT NULL,
        thinkingChars INTEGER DEFAULT NULL, hasImage INTEGER NOT NULL DEFAULT 0, imageCount INTEGER NOT NULL DEFAULT 0,
        hasSticker INTEGER NOT NULL DEFAULT 0, hasFile INTEGER NOT NULL DEFAULT 0
    )`;

const OLD_CHAT_SETTINGS = `
    CREATE TABLE chat_settings (
        chatId INTEGER PRIMARY KEY, model TEXT DEFAULT NULL, promptAddendum TEXT DEFAULT NULL,
        paused INTEGER NOT NULL DEFAULT 0, settingsLocked INTEGER NOT NULL DEFAULT 0,
        toolOverrides TEXT DEFAULT NULL, updatedAt TEXT NOT NULL, updatedBy INTEGER DEFAULT NULL
    )`;

const json = (value: unknown): string => JSON.stringify(value);

const columnsOf = async (table: string): Promise<string[]> => {
    const rows: unknown[] = await sequelize.query(`PRAGMA table_info(${table})`, { type: QueryTypes.SELECT });
    return rows.flatMap((row) => {
        if (typeof row !== 'object' || row === null) return [];
        const name: unknown = Object.fromEntries(Object.entries(row)).name;
        return typeof name === 'string' ? [name] : [];
    });
};

const tableExists = async (table: string): Promise<boolean> => {
    const rows: unknown[] = await sequelize.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = :table",
        { replacements: { table }, type: QueryTypes.SELECT }
    );
    return rows.length > 0;
};

const appliedMigrations = async (): Promise<string[]> => {
    const rows: unknown[] = await sequelize.query(
        // sqlite replacements do not expand arrays: json_each turns the list into rows
        'SELECT name FROM schema_migrations WHERE name IN (SELECT value FROM json_each(:namesJson)) ORDER BY name',
        { replacements: { namesJson: JSON.stringify(MIGRATION_NAMES) }, type: QueryTypes.SELECT }
    );
    return rows.flatMap((row) => {
        if (typeof row !== 'object' || row === null) return [];
        const name: unknown = Object.fromEntries(Object.entries(row)).name;
        return typeof name === 'string' ? [name] : [];
    });
};

const hasEvery = (columns: readonly string[], wanted: readonly string[]): boolean =>
    wanted.every((column) => columns.includes(column));

/** Startup as dbReady runs it: migrations first, then a plain sync */
const startUp = async (): Promise<void> => {
    await runSchemaMigrations();
    await sequelize.sync();
};

const metricInput = (fields: Partial<ReplyMetricInput>): ReplyMetricInput => ({
    chatId: -1007700000001,
    userMessageId: 10,
    firstMessageId: 11,
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
    rounds: 2,
    toolCalls: 0,
    toolFailures: 0,
    toolUsage: [],
    promptTokens: 2000,
    cachedTokens: 500,
    cacheWriteTokens: null,
    outputTokens: 120,
    thoughtsTokens: null,
    imageOutputTokens: null,
    contextMessages: 2,
    contextImages: 0,
    textChars: 5,
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
    ...fields,
});

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a fresh database starts with every new column, and the migrations skip tables that do not exist yet',
        body: async () => {
            expect(hasEvery(await columnsOf('reply_metrics'), REPLY_METRICS_COLUMNS), 'reply_metrics has the new columns');
            expect((await columnsOf('chat_settings')).includes('geminiPriority'), 'chat_settings has geminiPriority');
            expect(json(await appliedMigrations()) === json(MIGRATION_NAMES), 'both migrations are recorded');

            await sequelize.query('DROP TABLE reply_metrics');
            await sequelize.query('DROP TABLE chat_settings');
            await runSchemaMigrations();
            expect(
                !(await tableExists('reply_metrics')) && !(await tableExists('chat_settings')),
                'the migrations neither fail nor create the tables themselves'
            );
            await sequelize.sync();
            expect(hasEvery(await columnsOf('reply_metrics'), REPLY_METRICS_COLUMNS), 'sync creates reply_metrics with them');
            expect((await columnsOf('chat_settings')).includes('geminiPriority'), 'and chat_settings with geminiPriority');
        },
    },
    {
        name: 'an old reply_metrics table gains the columns, keeps its rows as NULL, and takes a new row',
        body: async () => {
            await sequelize.query('DROP TABLE reply_metrics');
            await sequelize.query(OLD_REPLY_METRICS);
            await sequelize.query(
                `INSERT INTO reply_metrics (chatId, userMessageId, firstMessageId, versionId, model, platform,
                                            commandType, startedAt, finishedAt, outcome, rounds)
                 VALUES (-1007700000001, 10, 11, 1, 'gemini-4-argon', 'gemini', 'chat',
                         '2026-11-10 10:00:00.000 +00:00', '2026-11-10 10:01:00.000 +00:00', 'error', 3)`
            );
            const before = await columnsOf('reply_metrics');
            expect(!REPLY_METRICS_COLUMNS.some((column) => before.includes(column)), 'the old table has none of them');

            await startUp();
            const after = await columnsOf('reply_metrics');
            expect(hasEvery(after, REPLY_METRICS_COLUMNS), `the migration adds all eight (got ${json(after)})`);
            expect(after.length === before.length + REPLY_METRICS_COLUMNS.length, 'and nothing else');

            const [old] = await findReplyMetricsByReply(-1007700000001, 11);
            expect(
                old?.outcome === 'error' &&
                    old.rounds === 3 &&
                    old.roundRetries === null &&
                    old.tierRequested === null &&
                    old.priorityRounds === null &&
                    old.resumedRounds === null &&
                    old.checkpointRounds === null,
                `the old row reads back with every new column NULL (got ${json(old)})`
            );

            await insertReplyMetric(
                metricInput({
                    versionId: 2,
                    isRetry: true,
                    roundRetries: 2,
                    tierRequested: 'priority',
                    priorityRounds: 1,
                    priorityPromptTokens: 900,
                    priorityCachedTokens: 300,
                    priorityOutputTokens: 60,
                    resumedRounds: 3,
                    checkpointRounds: 4,
                })
            );
            const [, written] = await findReplyMetricsByReply(-1007700000001, 11);
            expect(
                written?.versionId === 2 &&
                    written.roundRetries === 2 &&
                    written.tierRequested === 'priority' &&
                    written.priorityRounds === 1 &&
                    written.priorityPromptTokens === 900 &&
                    written.priorityCachedTokens === 300 &&
                    written.priorityOutputTokens === 60 &&
                    written.resumedRounds === 3 &&
                    written.checkpointRounds === 4,
                `a metric row written after the migration keeps every value (got ${json(written)})`
            );

            // A second start finds the columns and changes nothing
            await startUp();
            expect((await columnsOf('reply_metrics')).length === after.length, 'a restart adds no column');
            expect(json(await appliedMigrations()) === json(MIGRATION_NAMES), 'each migration is recorded once');
        },
    },
    {
        name: 'an old chat_settings table gains geminiPriority; its rows read as unset and take the switch afterwards',
        body: async () => {
            const chatId = -1007700000002;
            await sequelize.query('DROP TABLE chat_settings');
            await sequelize.query(OLD_CHAT_SETTINGS);
            await sequelize.query(
                `INSERT INTO chat_settings (chatId, model, paused, settingsLocked, updatedAt, updatedBy)
                 VALUES (${chatId}, 'old-model', 1, 0, '2026-11-10 10:00:00.000 +00:00', 4242)`
            );
            expect(!(await columnsOf('chat_settings')).includes('geminiPriority'), 'the old table has no geminiPriority');

            await startUp();
            expect((await columnsOf('chat_settings')).includes('geminiPriority'), 'the migration adds it');
            await service.loadChatSettingsCache();
            const old = service.getChatSettings(chatId);
            expect(
                old?.model === 'old-model' && old.paused && old.geminiPriority === null,
                `the old row keeps its values and reads as "follow the global switch" (got ${json(old)})`
            );

            const { settings } = await service.updateChatSettings({ chatId, patch: { geminiPriority: false }, actor: OWNER });
            expect(settings.geminiPriority === false && settings.model === 'old-model', 'the owner switches it off');
            await service.loadChatSettingsCache();
            expect(service.getChatSettings(chatId)?.geminiPriority === false, 'and the value survives a reload');

            await startUp();
            expect(
                (await columnsOf('chat_settings')).filter((column) => column === 'geminiPriority').length === 1,
                'a restart adds nothing'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
