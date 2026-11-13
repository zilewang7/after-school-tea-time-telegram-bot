import { QueryTypes, type Transaction } from '@sequelize/core';
import { sequelize } from './config.js';

interface TableColumn {
  name: string;
}

/** The existing tables a migration adds columns to */
type MigratedTable =
  | 'message_attachments'
  | 'link_preview_cache'
  | 'media_cache'
  | 'harness_issues'
  | 'chat_settings'
  | 'reply_metrics';

/**
 * Whether the table exists yet. Migrations run before sync, so on a fresh
 * database a table defined by a model does not exist here; sync then creates
 * it with every column, and the migration has nothing to add.
 */
const tableExists = async (tableName: MigratedTable, transaction: Transaction): Promise<boolean> => {
  const tables = await sequelize.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = :tableName",
    { type: QueryTypes.SELECT, replacements: { tableName }, transaction }
  );
  return tables.length > 0;
};

const tableColumns = async (
  tableName: MigratedTable,
  transaction: Transaction
): Promise<Set<string>> => {
  const columns = await sequelize.query<TableColumn>(
    `PRAGMA table_info(${tableName})`,
    { type: QueryTypes.SELECT, transaction }
  );
  return new Set(columns.map((column) => column.name));
};

const ensureColumn = async (
  tableName: MigratedTable,
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

/**
 * The panel's per-chat tool switches: canonical JSON in a nullable column, so
 * an existing database needs the column added once (a fresh one gets it from
 * the DTO at sync time, which runs after this).
 */
const migrateChatSettingsToolOverrides = async (transaction: Transaction): Promise<void> => {
  const tables = await sequelize.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_settings'",
    { type: QueryTypes.SELECT, transaction }
  );
  if (tables.length === 0) return;
  await ensureColumn('chat_settings', 'toolOverrides', 'TEXT', transaction);
};

/**
 * The Gemini resume and Priority PayGo columns of reply_metrics: automatic
 * round retries, the requested tier and the part served at the priority tier,
 * and the checkpoint facts of a resume. All nullable (NULL = nothing to
 * report), so old rows need no backfill and rolling the code back needs no
 * schema change. A fresh database gets them from the model at sync time.
 */
const migrateReplyMetricsResumeColumns = async (transaction: Transaction): Promise<void> => {
  if (!(await tableExists('reply_metrics', transaction))) return;
  await ensureColumn('reply_metrics', 'roundRetries', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'tierRequested', 'TEXT DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'priorityRounds', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'priorityPromptTokens', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'priorityCachedTokens', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'priorityOutputTokens', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'resumedRounds', 'INTEGER DEFAULT NULL', transaction);
  await ensureColumn('reply_metrics', 'checkpointRounds', 'INTEGER DEFAULT NULL', transaction);
};

/**
 * The per-chat Priority PayGo switch: a nullable boolean (NULL = follow the
 * global switch), stored as INTEGER like every sequelize BOOLEAN on sqlite.
 */
const migrateChatSettingsGeminiPriority = async (transaction: Transaction): Promise<void> => {
  if (!(await tableExists('chat_settings', transaction))) return;
  await ensureColumn('chat_settings', 'geminiPriority', 'INTEGER DEFAULT NULL', transaction);
};

/**
 * The share links of the control panel (design §6.1): one row per public
 * /s/<token> page. A system share (createdBy 0, source 'system') is the bot's
 * own link fallback in groups; user shares come from the panel.
 *
 * There is no sequelize model for this table on purpose: the panel reads and
 * writes it through raw SQL, so the migration is its only schema definition and
 * sequelize.sync() never rebuilds it.
 */
const migrateShareLinks = async (transaction: Transaction): Promise<void> => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token VARCHAR(255) NOT NULL UNIQUE,
      kind VARCHAR(255) NOT NULL,
      chatId INTEGER NOT NULL,
      firstMessageId INTEGER,
      rootId INTEGER,
      versionId INTEGER,
      createdBy INTEGER NOT NULL,
      source VARCHAR(255) NOT NULL DEFAULT 'user',
      createdAt DATETIME NOT NULL,
      revokedAt DATETIME,
      previewImageBase64 TEXT,
      previewWidth INTEGER,
      previewHeight INTEGER,
      previewSource VARCHAR(255),
      viewCount INTEGER NOT NULL DEFAULT 0,
      lastViewedAt DATETIME
    )
  `, { transaction });
  await sequelize.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS share_links_token ON share_links (token)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS share_links_target ON share_links (kind, chatId, firstMessageId, rootId, versionId, revokedAt)',
    { transaction }
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS share_links_created_by ON share_links (createdBy, createdAt)',
    { transaction }
  );
};

/**
 * Browser sessions for the panel's web login (design §6.2): one row per
 * `kob_web` cookie. Only the sha256 of the cookie value is stored, so a
 * database leak is not a set of usable sessions.
 *
 * Raw SQL only, like share_links: no sequelize model, so sync() never rebuilds it.
 */
const migratePanelWebSessions = async (transaction: Transaction): Promise<void> => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS panel_web_sessions (
      tokenHash VARCHAR(255) PRIMARY KEY,
      userId INTEGER NOT NULL,
      createdAt DATETIME NOT NULL,
      lastSeenAt DATETIME NOT NULL,
      expiresAt DATETIME NOT NULL
    )
  `, { transaction });
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS panel_web_sessions_user ON panel_web_sessions (userId, expiresAt)',
    { transaction }
  );
};

/**
 * The long-thinking view links (design §5.1): one row per reply version, whose
 * 24-character token is the only permission the public page and its JSON check.
 * A version that re-renders reuses its row through the unique target index.
 *
 * Raw SQL only, like share_links: no sequelize model, so sync() never rebuilds it.
 */
const migrateThinkingLinks = async (transaction: Transaction): Promise<void> => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS thinking_links (
      token TEXT PRIMARY KEY,
      chatId INTEGER NOT NULL,
      firstMessageId INTEGER NOT NULL,
      versionId INTEGER NOT NULL,
      model TEXT,
      createdAt DATETIME NOT NULL
    )
  `, { transaction });
  await sequelize.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS thinking_links_target ON thinking_links (chatId, firstMessageId, versionId)',
    { transaction }
  );
};

/** Apply additive, idempotent DDL without altering the large message table. */
/**
 * Indexes that Sequelize's sync cannot express (partial unique index): a
 * pending price proposal is unique per (model, tier, effectiveFrom, kind).
 *
 * Runs after sequelize.sync() (the tables are created there), and is
 * idempotent, so a restart is harmless.
 */
/**
 * One-off cleanup of the too-broad auto-add the first catalog watch performed
 * (2026-11-13): a family-prefix match alone also accepted old models (gpt-4o,
 * gpt-5.x, ...). Keeps only the seeded menu ids in model_catalog and drops the
 * price rows the watcher had proposed for those models. Recorded in
 * schema_migrations so it runs exactly once; later auto-adds are untouched.
 */
export const backfillCatalogSeedsOnly = async (): Promise<void> => {
    const { modelConfigs } = await import('../config/models.js');
    const name = '20261113_catalog_legacy_cleanup';
    const applied = await sequelize.query<{ name: string }>(
        'SELECT name FROM schema_migrations WHERE name = :name',
        { type: QueryTypes.SELECT, replacements: { name } }
    );
    if (applied.length > 0) return;
    const seedIds = modelConfigs.map((model) => model.id);
    const placeholders = seedIds.map((_, index) => `:seed${index}`).join(', ');
    const replacements = Object.fromEntries(seedIds.map((id, index) => [`seed${index}`, id]));
    await sequelize.transaction(async (transaction) => {
        await sequelize.query(
            `DELETE FROM model_catalog WHERE id NOT IN (${placeholders})`,
            { replacements, transaction }
        );
        await sequelize.query(
            `DELETE FROM model_price_entries
              WHERE source = 'models-dev' AND model NOT IN (${placeholders})`,
            { replacements, transaction }
        );
        await sequelize.query(
            `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
             VALUES (:name, :appliedAt)`,
            { replacements: { name, appliedAt: new Date().toISOString() }, transaction }
        );
    });
};

export const ensureModelPriceIndexes = async (): Promise<void> => {
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS price_change_proposals_pending_key
       ON price_change_proposals(model, tier, effectiveFrom, kind)
     WHERE status = 'pending'`
  );
};

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
    await migrateChatSettingsToolOverrides(transaction);
    await migrateShareLinks(transaction);
    await migratePanelWebSessions(transaction);
    await migrateThinkingLinks(transaction);
    await migrateReplyMetricsResumeColumns(transaction);
    await migrateChatSettingsGeminiPriority(transaction);
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
    // chat_settings gained toolOverrides (migrateChatSettingsToolOverrides)
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261108_chat_settings_tool_overrides', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // share_links is a brand-new table, created by migrateShareLinks above
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261109_share_links', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // panel_web_sessions is a brand-new table, created by migratePanelWebSessions above
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261109_panel_web_sessions', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // thinking_links is a brand-new table, created by migrateThinkingLinks above
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261111_thinking_links', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // workspace_files is also new: the DTO creates the table at sync time, this
    // row records the feature (its rows are LRU-cleaned by clearExpiredData).
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261112_workspace_files', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // access_applications / user_access are new tables too: their DTOs create
    // them at sync time, this row only records the feature.
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261112_user_access', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // reply_metrics gained the resume and Priority PayGo columns (migrateReplyMetricsResumeColumns)
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261112_reply_metrics_resume_priority', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // chat_settings gained geminiPriority (migrateChatSettingsGeminiPriority)
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261112_chat_settings_gemini_priority', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
    // model_price_entries / price_change_proposals / price_watch_runs /
    // model_catalog are new tables: their DTOs create them at sync time, the
    // partial unique index comes from ensureModelPriceIndexes.
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20261113_model_prices', :appliedAt)`,
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
