import { QueryTypes, type Transaction } from '@sequelize/core';
import { sequelize } from './config.js';

interface TableColumn {
  name: string;
}

const tableColumns = async (
  tableName: 'message_attachments' | 'link_preview_cache',
  transaction: Transaction
): Promise<Set<string>> => {
  const columns = await sequelize.query<TableColumn>(
    `PRAGMA table_info(${tableName})`,
    { type: QueryTypes.SELECT, transaction }
  );
  return new Set(columns.map((column) => column.name));
};

const ensureColumn = async (
  tableName: 'message_attachments' | 'link_preview_cache',
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
    await sequelize.query(
      `INSERT OR IGNORE INTO schema_migrations (name, appliedAt)
       VALUES ('20260908_custom_emoji_phase1', :appliedAt)`,
      { replacements: { appliedAt: new Date().toISOString() }, transaction }
    );
  });
};
