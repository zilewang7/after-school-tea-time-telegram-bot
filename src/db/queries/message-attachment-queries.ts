import { Op, QueryTypes, type Transaction } from '@sequelize/core';
import type { MessageRevisionToken } from './message-revision-queries.js';
import { sequelize } from '../config.js';
import { MessageAttachment } from '../messageAttachmentDTO.js';
import type { CustomEmojiOccurrence } from '../../services/custom-emoji-extractor.js';

const configuredPerMessageLimit = Number(process.env.CUSTOM_EMOJI_PER_MESSAGE ?? '8');
export const CUSTOM_EMOJI_PER_MESSAGE = Number.isSafeInteger(configuredPerMessageLimit)
  && configuredPerMessageLimit > 0
  ? Math.min(configuredPerMessageLimit, 8)
  : 8;

export const replaceCustomEmojiAttachments = async (
  revision: MessageRevisionToken,
  occurrences: CustomEmojiOccurrence[],
  transaction?: Transaction
): Promise<void> => {
  const { chatId, messageId, updateId, telegramTimestamp } = revision;
  await MessageAttachment.destroy({
    where: { chatId, messageId, role: 'custom_emoji' },
    transaction,
  });
  if (occurrences.length === 0) return;

  const selectedIds = new Set<string>();
  for (const occurrence of occurrences) {
    if (selectedIds.has(occurrence.customEmojiId)) continue;
    if (selectedIds.size >= CUSTOM_EMOJI_PER_MESSAGE) break;
    selectedIds.add(occurrence.customEmojiId);
  }

  await MessageAttachment.bulkCreate(
    occurrences.map((occurrence) => {
      const selected = selectedIds.has(occurrence.customEmojiId);
      return {
        chatId,
        messageId,
        ordinal: occurrence.ordinal,
        role: 'custom_emoji' as const,
        source: occurrence.source,
        customEmojiId: occurrence.customEmojiId,
        offsetUtf16: occurrence.offsetUtf16,
        lengthUtf16: occurrence.lengthUtf16,
        fallbackText: occurrence.fallbackText,
        mediaKey: null,
        status: selected ? 'pending' as const : 'omitted' as const,
        failureReason: selected ? null : 'per-message custom emoji budget exceeded',
        sourceRevision: updateId,
        sourceTimestamp: telegramTimestamp,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }),
    { transaction }
  );
};

export const getCustomEmojiAttachmentsForMessages = async (
  chatId: number,
  messageIds: number[]
): Promise<Map<number, MessageAttachment[]>> => {
  const grouped = new Map<number, MessageAttachment[]>();
  if (messageIds.length === 0) return grouped;

  const rows = await MessageAttachment.findAll({
    where: {
      chatId,
      messageId: { [Op.in]: messageIds },
      role: 'custom_emoji',
    },
    order: [['messageId', 'ASC'], ['ordinal', 'ASC']],
  });
  for (const row of rows) {
    const existing = grouped.get(row.messageId);
    if (existing) existing.push(row);
    else grouped.set(row.messageId, [row]);
  }
  return grouped;
};

export const getPendingCustomEmojiAttachments = async (
  revision: MessageRevisionToken
): Promise<MessageAttachment[]> =>
  MessageAttachment.findAll({
    where: {
      chatId: revision.chatId,
      messageId: revision.messageId,
      sourceRevision: revision.updateId,
      sourceTimestamp: revision.telegramTimestamp,
      role: 'custom_emoji',
      status: 'pending',
    },
    order: [['ordinal', 'ASC']],
  });

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

export const markCustomEmojiAttachments = async (input: {
  revision: MessageRevisionToken;
  customEmojiId: string;
  status: 'ready' | 'failed';
  mediaKey?: string | null;
  failureReason?: string | null;
}): Promise<number> => sequelize.transaction(async (transaction) => {
  const { revision } = input;
  await sequelize.query(
    `UPDATE message_attachments
     SET status = :status,
         mediaKey = :mediaKey,
         failureReason = :failureReason,
         updatedAt = :updatedAt
     WHERE chatId = :chatId
       AND messageId = :messageId
       AND sourceRevision = :updateId
       AND sourceTimestamp = :telegramTimestamp
       AND customEmojiId = :customEmojiId
       AND role = 'custom_emoji'
       AND status = 'pending'
       AND EXISTS (
         SELECT 1
         FROM message_revisions AS revision
         WHERE revision.chatId = message_attachments.chatId
           AND revision.messageId = message_attachments.messageId
           AND revision.updateId = :updateId
           AND revision.telegramTimestamp = :telegramTimestamp
       )`,
    {
      replacements: {
        ...revision,
        customEmojiId: input.customEmojiId,
        status: input.status,
        mediaKey: input.mediaKey ?? null,
        failureReason: input.failureReason ?? null,
        updatedAt: new Date().toISOString(),
      },
      transaction,
    }
  );
  return readChangeCount(transaction);
});

export const failPendingCustomEmojiAttachments = async (
  revision: MessageRevisionToken,
  failureReason: string
): Promise<number> => sequelize.transaction(async (transaction) => {
  await sequelize.query(
    `UPDATE message_attachments
     SET status = 'failed',
         mediaKey = NULL,
         failureReason = :failureReason,
         updatedAt = :updatedAt
     WHERE chatId = :chatId
       AND messageId = :messageId
       AND sourceRevision = :updateId
       AND sourceTimestamp = :telegramTimestamp
       AND role = 'custom_emoji'
       AND status = 'pending'
       AND EXISTS (
         SELECT 1
         FROM message_revisions AS revision
         WHERE revision.chatId = message_attachments.chatId
           AND revision.messageId = message_attachments.messageId
           AND revision.updateId = :updateId
           AND revision.telegramTimestamp = :telegramTimestamp
       )`,
    {
      replacements: {
        ...revision,
        failureReason,
        updatedAt: new Date().toISOString(),
      },
      transaction,
    }
  );
  return readChangeCount(transaction);
});

export const failOrphanedPendingCustomEmojiAttachments = async (): Promise<number> =>
  sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `UPDATE message_attachments
       SET status = 'failed',
           mediaKey = NULL,
           failureReason = 'source message revision is no longer current',
           updatedAt = :updatedAt
       WHERE role = 'custom_emoji'
         AND status = 'pending'
         AND NOT EXISTS (
           SELECT 1
           FROM message_revisions AS revision
           WHERE revision.chatId = message_attachments.chatId
             AND revision.messageId = message_attachments.messageId
             AND revision.updateId = message_attachments.sourceRevision
             AND revision.telegramTimestamp = message_attachments.sourceTimestamp
         )`,
      { replacements: { updatedAt: new Date().toISOString() }, transaction }
    );
    return readChangeCount(transaction);
  });

export const getRecoverableCustomEmojiRevisions = async (
  limit: number
): Promise<MessageRevisionToken[]> => sequelize.query<MessageRevisionToken>(
  `SELECT DISTINCT
      attachment.chatId AS chatId,
      attachment.messageId AS messageId,
      attachment.sourceRevision AS updateId,
      attachment.sourceTimestamp AS telegramTimestamp
   FROM message_attachments AS attachment
   INNER JOIN message_revisions AS revision
     ON revision.chatId = attachment.chatId
    AND revision.messageId = attachment.messageId
    AND revision.updateId = attachment.sourceRevision
    AND revision.telegramTimestamp = attachment.sourceTimestamp
   WHERE attachment.role = 'custom_emoji'
     AND attachment.status = 'pending'
   ORDER BY attachment.updatedAt ASC
   LIMIT :limit`,
  { replacements: { limit }, type: QueryTypes.SELECT }
);

export const getFailedCustomEmojiAttachments = async (
  chatId: number,
  messageId: number
): Promise<MessageAttachment[]> =>
  MessageAttachment.findAll({
    where: { chatId, messageId, role: 'custom_emoji', status: 'failed' },
    order: [['ordinal', 'ASC']],
  });
