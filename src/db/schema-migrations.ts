import { QueryTypes, type Transaction } from '@sequelize/core';
import { sequelize } from './config.js';

interface TableColumn {
  name: string;
}

const tableColumns = async (
  tableName: 'message_attachments' | 'link_preview_cache' | 'media_cache' | 'harness_issues',
  transaction: Transaction
): Promise<Set<string>> => {
  const columns = await sequelize.query<TableColumn>(
    `PRAGMA table_info(${tableName})`,
    { type: QueryTypes.SELECT, transaction }
  );
  return new Set(columns.map((column) => column.name));
};

const ensureColumn = async (
  tableName: 'message_attachments' | 'link_preview_cache' | 'media_cache' | 'harness_issues',
  columnName: string,
  definition: string,
  transaction: Transaction
): Promise<void> => {
  const columns = await tableColumns(tableName, transaction);
  if (columns.has(columnName)) return;
  await sequelize.query(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
    { transaction }
  );
};

const migrateCustomEmojiSchema = async (transaction: Transaction): Promise<void> => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER NOT NULL,
      messageId INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      role VARCHAR(255) NOT NULL,
      source VARCHAR(255) NOT NULL,
      customEmojiId VARCHAR(255) NOT NULL,
      offsetUtf16 INTEGER,
      lengthUtf16 INTEGER,
      fallbackText TEXT NOT NULL,
      mediaKey VARCHAR(255),
      status VARCHAR(255) NOT NULL,
      failureReason TEXT,
      sourceRevision INTEGER NOT NULL,
      sourceTimestamp INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL
    )
  `, { transaction });
  await ensureColumn(
    'message_attachments',
    'sourceTimestamp',
    'INTEGER NOT NULL DEFAULT 0',
    transaction
  );
  await sequelize.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS message_attachments_chat_id_message_id_role_ordinal_unique ON message_attachments (chatId, messageId, role, ordinal)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS message_attachments_chat_id_message_id_status ON message_attachments (chatId, messageId, status)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS message_attachments_role_status_updated_at ON message_attachments (role, status, updatedAt)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS message_attachments_custom_emoji_id ON message_attachments (customEmojiId)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS message_attachments_created_at ON message_attachments (createdAt)',
    { transaction }
  );

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS custom_emoji_assets (
      customEmojiId VARCHAR(255) PRIMARY KEY,
      fileId VARCHAR(255),
      fileUniqueId VARCHAR(255),
      kind VARCHAR(255),
      sourceMime VARCHAR(255),
      previewMediaKey VARCHAR(255),
      fallbackEmoji TEXT,
      needsRepainting INTEGER,
      status VARCHAR(255) NOT NULL,
      failureReason TEXT,
      resolvedAt DATETIME,
      lastUsedAt DATETIME NOT NULL
    )
  `, { transaction });
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS custom_emoji_assets_file_unique_id ON custom_emoji_assets (fileUniqueId)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS custom_emoji_assets_last_used_at ON custom_emoji_assets (lastUsedAt)',
    { transaction }
  );

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS message_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER NOT NULL,
      messageId INTEGER NOT NULL,
      updateId INTEGER NOT NULL,
      telegramTimestamp INTEGER NOT NULL,
      updatedAt DATETIME NOT NULL
    )
  `, { transaction });
  await sequelize.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS message_revisions_chat_id_message_id_unique ON message_revisions (chatId, messageId)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS message_revisions_updated_at ON message_revisions (updatedAt)',
    { transaction }
  );
};

const migratePreviewOcrRevision = async (transaction: Transaction): Promise<void> => {
  const tables = await sequelize.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'link_preview_cache'",
    { type: QueryTypes.SELECT, transaction }
  );
  if (tables.length === 0) return;
  await ensureColumn(
    'link_preview_cache',
    'ocrSourceTimestamp',
    'INTEGER',
    transaction
  );
  await ensureColumn(
    'link_preview_cache',
    'ocrSourceUpdateId',
    'INTEGER',
    transaction
  );
};

/**
 * Video duration (seconds) for cached media, used to pick the model's frame
 * sampling rate. Nullable and left NULL for non-videos and for every row cached
 * before this column existed — the readers treat NULL as "length unknown".
 * A fresh database needs nothing here: sequelize.sync() creates the table with
 * the column, and this migration runs before that sync.
 */
const migrateMediaCacheDurationSeconds = async (transaction: Transaction): Promise<void> => {
  const tables = await sequelize.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_cache'",
    { type: QueryTypes.SELECT, transaction }
  );
  if (tables.length === 0) return;
  await ensureColumn('media_cache', 'durationSeconds', 'INTEGER', transaction);
};

/**
 * The control panel's three harness_issues columns: the owner's handling note,
 * who filed the issue (model | user; every existing row was filed by the
 * model) and the filing person's id. Same shape as the media_cache column
 * above: skipped on a fresh database, where sync creates the table from the
 * DTO with all three; on an existing one each column is added once, so a
 * restart finds them and does nothing.
 */
const migrateHarnessIssuePanelColumns = async (transaction: Transaction): Promise<void> => {
  const tables = await sequelize.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_issues'",
    { type: QueryTypes.SELECT, transaction }
  );
  if (tables.length === 0) return;
  await ensureColumn('harness_issues', 'note', 'TEXT', transaction);
  await ensureColumn('harness_issues', 'source', "VARCHAR(255) NOT NULL DEFAULT 'model'", transaction);
  await ensureColumn('harness_issues', 'createdBy', 'INTEGER', transaction);
};

/** Apply additive, idempotent DDL without altering the large message table. */
export const runSchemaMigrations = async (): Promise<void> => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      appliedAt DATETIME NOT NULL
    )
  `);

  await sequelize.transaction(async (transaction) => {
    await migrateCustomEmojiSchema(transaction);
    await migratePreviewOcrRevision(transaction);
    await migrateMediaCacheDurationSeconds(transaction);
    await migrateHarnessIssuePanelColumns(transaction);
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20260908_custom_emoji_phase1', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261010_media_cache_duration_seconds', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // tg_message_link_cache is a brand-new table: sequelize.sync() below creates
    // it, this row only records that the feature's schema has been applied.
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261021_tg_message_link_cache', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // harness_issues is also new: the DTO creates the table at sync time, this
    // row records the feature. Only people change its status column.
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261104_harness_issues', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // The control panel's tables (chats, chat_members_seen, chat_settings,
    // global_settings, settings_audit) are new: sync creates them from their
    // DTOs, this row records the feature. Their first rows come from
    // backfillPanelRegistry below.
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261106_miniapp_panel', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // harness_issues gained note / source / createdBy (migrateHarnessIssuePanelColumns)
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261107_harness_issue_panel_columns', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
  });
};

/**
 * Historical GIFs were captured as documents (the animation branch is newer):
 * their hint names a converted .gif.mp4 and their cache row is kind=document.
 * Rewrite both so the first-frame path can find them.
 *
 * Runs after sequelize.sync() — the table does not exist on a fresh database
 * when runSchemaMigrations executes. Recorded so the LIKE scan over the large
 * message table happens once; the statements themselves are idempotent.
 */
export const backfillAnimationMediaKind = async (): Promise<void> => {
  const name = '20261027_animation_media_kind';
  const applied = await sequelize.query<{ name: string }>(
    'SELECT name FROM schema_migrations WHERE name = :name',
    { type: QueryTypes.SELECT, replacements: { name } }
  );
  if (applied.length > 0) return;

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `UPDATE telegram_messages
          SET mediaHint = 'an animation'
        WHERE fileMime LIKE 'video/%'
          AND mediaHint LIKE 'a file: %.gif.mp4%'`,
      { transaction }
    );
    await sequelize.query(
      `UPDATE media_cache
          SET kind = 'animation'
        WHERE mime = 'video/mp4'
          AND kind = 'document'
          AND fileUniqueId IN (
              SELECT DISTINCT fileUniqueId FROM telegram_messages WHERE mediaHint = 'an animation'
          )`,
      { transaction }
    );
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES (:name, :appliedAt)`,
      { replacements: { name, appliedAt: new Date().toISOString() }, transaction }
    );
  });
};

/**
 * Seed the panel's chat registry from the messages already stored, once.
 *
 * Without it, a chat with no new message since the panel shipped could not be
 * opened by anyone (the owner included), and old group members would start with
 * an empty chat list. Only the last 7 days of messages exist, so only chats and
 * speakers active in that window are seeded; titles stay NULL until the chat's
 * next message. Chats that only have bot rows are covered through
 * bot_responses. Senders that are not people are skipped: luoxu backfill (0),
 * the Telegram service account (777000), GroupAnonymousBot (1087968824) and
 * every account the roster knows to be a bot.
 *
 * Runs after sequelize.sync() (the tables are new); INSERT OR IGNORE keeps it
 * from touching rows autoSave already wrote.
 */
export const backfillPanelRegistry = async (): Promise<void> => {
  const name = '20261106_miniapp_panel_backfill';
  const applied = await sequelize.query<{ name: string }>(
    'SELECT name FROM schema_migrations WHERE name = :name',
    { type: QueryTypes.SELECT, replacements: { name } }
  );
  if (applied.length > 0) return;

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `INSERT OR IGNORE INTO chats (chatId, type, title, username, firstSeenAt, lastSeenAt)
       SELECT chatId,
              CASE WHEN chatId > 0 THEN 'private'
                   WHEN chatId <= -1000000000000 THEN 'supergroup'
                   ELSE 'group' END,
              NULL, NULL, MIN(seenAt), MAX(seenAt)
         FROM (SELECT chatId, date AS seenAt FROM telegram_messages
               UNION ALL
               SELECT chatId, createdAt AS seenAt FROM bot_responses)
        GROUP BY chatId`,
      { transaction }
    );
    await sequelize.query(
      `INSERT OR IGNORE INTO chat_members_seen (chatId, userId, firstSeenAt, lastSeenAt, messageCount)
       SELECT m.chatId, m.userId, MIN(m.date), MAX(m.date), COUNT(*)
         FROM telegram_messages m
         LEFT JOIN telegram_users u ON u.userId = m.userId
        WHERE m.chatId < 0 AND m.fromBotSelf = 0 AND m.userId IS NOT NULL
          AND m.userId NOT IN (0, 777000, 1087968824)
          AND COALESCE(u.isBot, 0) = 0
        GROUP BY m.chatId, m.userId`,
      { transaction }
    );
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES (:name, :appliedAt)`,
      { replacements: { name, appliedAt: new Date().toISOString() }, transaction }
    );
  });
};
