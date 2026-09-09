import { QueryTypes, type Transaction } from '@sequelize/core';
import { sequelize } from '../config.js';

export interface MessageRevisionToken {
  chatId: number;
  messageId: number;
  updateId: number;
  telegramTimestamp: number;
}

interface ChangeCount {
  changed: number;
}

const readChangeCount = async (transaction: Transaction): Promise<number> => {
  const changes = await sequelize.query<ChangeCount>(
    'SELECT changes() AS changed',
    { type: QueryTypes.SELECT, transaction }
  );
  return changes[0]?.changed ?? 0;
};

/** Atomically claim a newer Telegram update for one message. */
export const claimMessageRevision = async (
  token: MessageRevisionToken,
  transaction: Transaction
): Promise<boolean> => {
  await sequelize.query(
    `INSERT INTO message_revisions
      (chatId, messageId, updateId, telegramTimestamp, updatedAt)
     VALUES (:chatId, :messageId, :updateId, :telegramTimestamp, :updatedAt)
     ON CONFLICT (chatId, messageId) DO UPDATE SET
       updateId = excluded.updateId,
       telegramTimestamp = excluded.telegramTimestamp,
       updatedAt = excluded.updatedAt
     WHERE excluded.telegramTimestamp > message_revisions.telegramTimestamp
         OR (
           excluded.telegramTimestamp = message_revisions.telegramTimestamp
           AND excluded.updateId > message_revisions.updateId
         )`,
    {
      replacements: {
        ...token,
        updatedAt: new Date().toISOString(),
      },
      transaction,
    }
  );
  return (await readChangeCount(transaction)) === 1;
};

export type MessageMediaRevisionUpdate =
  | { mediaHint: string }
  | { mediaHint: string; fileMime: string; fileUniqueId: string };

const currentRevisionPredicate = `
  EXISTS (
    SELECT 1
    FROM message_revisions AS revision
    WHERE revision.chatId = telegram_messages.chatId
      AND revision.messageId = telegram_messages.messageId
      AND revision.updateId = :updateId
      AND revision.telegramTimestamp = :telegramTimestamp
  )`;

/** Write media fields in one SQL-level CAS against the current revision. */
export const updateMessageMediaForRevision = async (
  token: MessageRevisionToken,
  values: MessageMediaRevisionUpdate
): Promise<boolean> => sequelize.transaction(async (transaction) => {
  const hasMedia = 'fileMime' in values;
  await sequelize.query(
    hasMedia
      ? `UPDATE telegram_messages
         SET fileMime = :fileMime,
             fileUniqueId = :fileUniqueId,
             mediaHint = :mediaHint,
             updatedAt = :updatedAt
         WHERE chatId = :chatId
           AND messageId = :messageId
           AND ${currentRevisionPredicate}`
      : `UPDATE telegram_messages
         SET mediaHint = :mediaHint,
             updatedAt = :updatedAt
         WHERE chatId = :chatId
           AND messageId = :messageId
           AND ${currentRevisionPredicate}`,
    {
      replacements: {
        ...token,
        ...values,
        updatedAt: new Date().toISOString(),
      },
      transaction,
    }
  );
  return (await readChangeCount(transaction)) > 0;
});

/** Store or clear OCR in one SQL-level CAS against the source media revision. */
export const updateMessageOcrForRevision = async (
  token: MessageRevisionToken,
  ocrText: string | null
): Promise<boolean> => sequelize.transaction(async (transaction) => {
  await sequelize.query(
    `UPDATE telegram_messages
     SET ocrText = :ocrText,
         updatedAt = :updatedAt
     WHERE chatId = :chatId
       AND messageId = :messageId
       AND ${currentRevisionPredicate}`,
    {
      replacements: {
        ...token,
        ocrText,
        updatedAt: new Date().toISOString(),
      },
      transaction,
    }
  );
  return (await readChangeCount(transaction)) > 0;
});

/** Update URL-scoped OCR only from a current, monotonically newer message revision. */
export const updateLinkPreviewOcrForRevision = async (
  token: MessageRevisionToken,
  url: string,
  ocrText: string | null
): Promise<boolean> => sequelize.transaction(async (transaction) => {
  await sequelize.query(
    `UPDATE link_preview_cache
     SET ocrText = :ocrText,
         ocrSourceTimestamp = :telegramTimestamp,
         ocrSourceUpdateId = :updateId
     WHERE url = :url
       AND EXISTS (
         SELECT 1
         FROM message_revisions AS revision
         WHERE revision.chatId = :chatId
           AND revision.messageId = :messageId
           AND revision.updateId = :updateId
           AND revision.telegramTimestamp = :telegramTimestamp
       )
       AND (
         ocrSourceTimestamp IS NULL
         OR :telegramTimestamp > ocrSourceTimestamp
         OR (
           :telegramTimestamp = ocrSourceTimestamp
           AND (
             ocrSourceUpdateId IS NULL
             OR :updateId >= ocrSourceUpdateId
           )
         )
       )`,
    {
      replacements: { ...token, url, ocrText },
      transaction,
    }
  );
  return (await readChangeCount(transaction)) > 0;
});
