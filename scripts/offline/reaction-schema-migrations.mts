/**
 * Offline cases for the reaction/parts schema migrations (design 2026-1123-1610
 * §2.2/§7): an existing database must gain the message_reactions source/part
 * columns (with legacy rows backfilled) and bot_responses must be rebuilt from
 * the single-column messageId key to the composite (chatId, messageId) key
 * without losing rows — and the reverse script must bring the old shape back for
 * a rollback, reporting the rows a single-column key cannot hold.
 *
 * Every other offline file runs on a fresh database, where sync creates both
 * tables in their new shape and the migrations skip; without these cases a
 * broken migration would only show in production at the first restart.
 *
 * Run: npx tsx scripts/offline/reaction-schema-migrations.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

await setupOfflineDb();
const { QueryTypes } = await import('@sequelize/core');
const { sequelize } = await import('../../src/db/config.js');
const {
    migrateBotResponsesCompositeKey,
    migrateMessageReactionsParts,
    rollbackBotResponsesCompositeKey,
} = await import('../../src/db/schema-migrations.js');

interface ColumnInfo {
    name: string;
    pk: number;
}

const columnsOf = async (table: string): Promise<ColumnInfo[]> =>
    sequelize.query<ColumnInfo>(`PRAGMA table_info(${table})`, { type: QueryTypes.SELECT });

const primaryKeyColumns = async (table: string): Promise<string[]> =>
    (await columnsOf(table))
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);

const indexNames = async (table: string): Promise<string[]> => {
    const rows = await sequelize.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = :table",
        { type: QueryTypes.SELECT, replacements: { table } }
    );
    return rows.map((row) => row.name);
};

/** The old single-column-key table, in the DDL the previous builds created */
const LEGACY_BOT_RESPONSES = `
    CREATE TABLE bot_responses (
      messageId INTEGER PRIMARY KEY,
      chatId INTEGER NOT NULL,
      userMessageId INTEGER NOT NULL,
      currentVersionIndex INTEGER NOT NULL DEFAULT 0,
      versions TEXT NOT NULL DEFAULT '"[]"',
      buttonState VARCHAR(255) NOT NULL DEFAULT 'none',
      metadata TEXT NOT NULL DEFAULT '"{}"',
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL
    )
`;

/** The table before the source/part columns (2026-11-20 shape) */
const LEGACY_MESSAGE_REACTIONS = `
    CREATE TABLE message_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER NOT NULL,
      messageId INTEGER NOT NULL,
      userId INTEGER,
      actorChatId INTEGER,
      userName VARCHAR(255),
      fromBotSelf TINYINT(1) NOT NULL DEFAULT 0,
      kind VARCHAR(255) NOT NULL,
      emoji VARCHAR(255),
      customEmojiId VARCHAR(255),
      createdAt DATETIME NOT NULL
    )
`;

const results: CaseResult[] = [];

results.push(await runCase('message_reactions: legacy rows gain sourceMessageId; part stays NULL', async () => {
    await sequelize.query('DROP TABLE IF EXISTS message_reactions');
    await sequelize.query(LEGACY_MESSAGE_REACTIONS);
    await sequelize.query(
        `INSERT INTO message_reactions (chatId, messageId, userId, userName, fromBotSelf, kind, emoji, createdAt)
         VALUES (1, 10, 42, 'legacy', 0, 'emoji', '👍', '2026-11-21 00:00:00.000 +00:00')`
    );

    await sequelize.transaction((transaction) => migrateMessageReactionsParts(transaction));

    const columns = (await columnsOf('message_reactions')).map((column) => column.name);
    expect(columns.includes('sourceMessageId'), 'sourceMessageId column exists');
    expect(columns.includes('part'), 'part column exists');
    expect(columns.includes('partIndex'), 'partIndex column exists');
    const rows = await sequelize.query<{ sourceMessageId: number; part: string | null }>(
        'SELECT sourceMessageId, part FROM message_reactions WHERE chatId = 1 AND messageId = 10',
        { type: QueryTypes.SELECT }
    );
    expect(rows.length === 1, 'the legacy row is kept');
    expect(rows[0]?.sourceMessageId === 10, `sourceMessageId backfilled to messageId (got ${String(rows[0]?.sourceMessageId)})`);
    expect(rows[0]?.part === null, 'part of a pre-parts row is unknown (NULL)');
    expect(
        (await indexNames('message_reactions')).includes('message_reactions_chat_id_source_message_id'),
        'the source lookup index exists'
    );

    // Idempotent: a second run finds the columns and only re-runs the no-op UPDATE
    await sequelize.transaction((transaction) => migrateMessageReactionsParts(transaction));
    expect((await columnsOf('message_reactions')).length === columns.length, 'a second run adds nothing');

    // The DTO reads the migrated table through its model
    const { MessageReaction } = await import('../../src/db/messageReactionDTO.js');
    const stored = await MessageReaction.findOne({ where: { chatId: 1, messageId: 10 } });
    expect(stored?.sourceMessageId === 10 && stored.emoji === '👍', 'the model reads the migrated row');
    await MessageReaction.destroy({ where: { chatId: 1, messageId: 10 } });
}));

results.push(await runCase('bot_responses: rebuilt to (chatId, messageId) keeping rows and indexes', async () => {
    await sequelize.query('DROP TABLE IF EXISTS bot_responses');
    await sequelize.query(LEGACY_BOT_RESPONSES);
    await sequelize.query(
        `INSERT INTO bot_responses (messageId, chatId, userMessageId, versions, buttonState, metadata, createdAt, updatedAt)
         VALUES (100, -1, 90, '"[]"', 'none', '{}', '2026-11-21 00:00:00.000 +00:00', '2026-11-21 00:00:00.000 +00:00'),
                (101, -2, 91, '"[]"', 'none', '{}', '2026-11-21 00:00:00.000 +00:00', '2026-11-21 00:00:00.000 +00:00')`
    );

    await sequelize.transaction((transaction) => migrateBotResponsesCompositeKey(transaction));

    const key = await primaryKeyColumns('bot_responses');
    expect(key.length === 2, `two key columns (got ${JSON.stringify(key)})`);
    expect(key[0] === 'chatId' && key[1] === 'messageId', 'the key is (chatId, messageId)');
    const rows = await sequelize.query<{ messageId: number; chatId: number; userMessageId: number }>(
        'SELECT messageId, chatId, userMessageId FROM bot_responses',
        { type: QueryTypes.SELECT }
    );
    expect(rows.length === 2, 'both replies are kept');
    expect(
        rows.some((row) => row.chatId === -1 && row.messageId === 100 && row.userMessageId === 90) &&
            rows.some((row) => row.chatId === -2 && row.messageId === 101 && row.userMessageId === 91),
        'row content survives the rebuild'
    );
    const indexes = await indexNames('bot_responses');
    expect(indexes.includes('bot_responses_chat_id_user_message_id'), 'userMessageId index recreated');
    expect(indexes.includes('bot_responses_created_at'), 'createdAt index recreated');

    // Idempotent: already composite, nothing is rebuilt
    await sequelize.transaction((transaction) => migrateBotResponsesCompositeKey(transaction));
    const after = await primaryKeyColumns('bot_responses');
    expect(after[0] === 'chatId' && after[1] === 'messageId', 'a second run keeps the composite key');

    const { BotResponse } = await import('../../src/db/botResponseDTO.js');
    const stored = await BotResponse.findOne({ where: { chatId: -1, messageId: 100 } });
    expect(stored?.userMessageId === 90, 'the model reads the migrated row');

    // The same messageId may now exist in two chats (the bug the key change fixes)
    await sequelize.query(
        `INSERT INTO bot_responses (messageId, chatId, userMessageId, versions, buttonState, metadata, createdAt, updatedAt)
         VALUES (100, -2, 92, '"[]"', 'none', '{}', '2026-11-21 01:00:00.000 +00:00', '2026-11-21 01:00:00.000 +00:00')`
    );
    const both = await BotResponse.findAll({ where: { messageId: 100 } });
    expect(both.length === 2, `two chats may share a first message id (got ${both.length})`);
    expect((await BotResponse.findOne({ where: { chatId: -1, messageId: 100 } }))?.userMessageId === 90, 'the original row still resolves for its chat');
}));

results.push(await runCase('rollback: single-column key restored, unrepresentable rows reported', async () => {
    // The previous case left a cross-chat duplicate (messageId 100 in chats -1 and -2)
    const result = await rollbackBotResponsesCompositeKey();
    expect(result.alreadySingle === false, 'the rollback rebuilt the table');
    expect(result.dropped === 1, `one row cannot live under the old key (got ${result.dropped})`);
    const key = await primaryKeyColumns('bot_responses');
    expect(key.length === 1 && key[0] === 'messageId', 'the key is messageId alone again');
    const rows = await sequelize.query<{ messageId: number; userMessageId: number }>(
        'SELECT messageId, userMessageId FROM bot_responses ORDER BY messageId',
        { type: QueryTypes.SELECT }
    );
    // 101 stays; of the two 100 rows the newer one wins
    expect(rows.length === 2, `one row per message id (got ${rows.length})`);
    expect(rows.find((row) => row.messageId === 100)?.userMessageId === 92, 'the newest row wins');
    expect(rows.find((row) => row.messageId === 101)?.userMessageId === 91, 'the other reply is untouched');

    // Running it again says there is nothing to do
    const again = await rollbackBotResponsesCompositeKey();
    expect(again.alreadySingle === true && again.rows === 0, 'a second rollback is a no-op');
}));

reportResults(results);
