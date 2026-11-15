/**
 * Reads and writes of a reply's pictures as message rows (`message_media`).
 *
 * The table is the single read source for the context builder and the panel:
 * a bot reply's pictures are listed here in delivery order even when they were
 * delivered as several messages (an album) that have no row of their own in
 * `telegram_messages`. Writes happen when a reply is finalized or a version is
 * switched; `replaceMessageMedia` replaces the whole set, so a version switch
 * never leaves the previous version's pictures behind.
 */
import { Op, type Transaction } from '@sequelize/core';
import { MessageMedia, toStoredMessageMedia, type StoredMessageMedia } from '../messageMediaDTO.js';

/** The pictures of one message, in delivery order (empty when it has none) */
export const listMessageMedia = async (
  chatId: number,
  messageId: number
): Promise<StoredMessageMedia[]> => {
  const rows = await MessageMedia.findAll({
    where: { chatId, messageId },
    order: [['ordinal', 'ASC']],
  });
  return rows.map(toStoredMessageMedia);
};

/**
 * SQLite's bound-variable limit is far below the message count of a long
 * context: one query per page keeps the whole build from failing.
 */
const MEDIA_MESSAGE_ID_BATCH = 500;

/**
 * The pictures of many messages of one chat, keyed by message id; messages
 * without pictures are absent. Chunked, so a long context stays one map.
 */
export const listMessageMediaForMessages = async (
  chatId: number,
  messageIds: readonly number[]
): Promise<Map<number, StoredMessageMedia[]>> => {
  const byMessageId = new Map<number, StoredMessageMedia[]>();
  if (messageIds.length === 0) return byMessageId;

  for (let start = 0; start < messageIds.length; start += MEDIA_MESSAGE_ID_BATCH) {
    const batch = messageIds.slice(start, start + MEDIA_MESSAGE_ID_BATCH);
    const rows = await MessageMedia.findAll({
      where: { chatId, messageId: { [Op.in]: [...batch] } },
      order: [['messageId', 'ASC'], ['ordinal', 'ASC']],
    });
    for (const row of rows) {
      const media = byMessageId.get(row.messageId);
      const item = toStoredMessageMedia(row);
      if (media === undefined) byMessageId.set(row.messageId, [item]);
      else media.push(item);
    }
  }
  return byMessageId;
};

/**
 * Replace one message's picture rows with `media` (whole-set replacement:
 * finalize and version switching both call it, so a stale set cannot survive).
 * Rows without a `mediaKey` are dropped: only content-addressed pictures can
 * be listed here; a legacy single picture stays in the message row's bytes.
 */
export const replaceMessageMedia = async (
  chatId: number,
  messageId: number,
  media: readonly StoredMessageMedia[],
  transaction?: Transaction
): Promise<void> => {
  await MessageMedia.destroy({ where: { chatId, messageId }, transaction });
  const rows = media.flatMap((item, index) => (
    item.mediaKey === ''
      ? []
      : [{
          chatId,
          messageId,
          ordinal: index + 1,
          mediaKey: item.mediaKey,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          caption: item.caption ?? null,
          placement: item.placement,
        }]
  ));
  if (rows.length === 0) return;
  await MessageMedia.bulkCreate(rows, { transaction });
};

/**
 * Delete the picture rows of the given message keys; the hourly cleanup calls
 * this with one batch of (chatId, messageId) pairs.
 */
export const deleteMessageMediaForKeys = async (
  keys: readonly { readonly chatId: number; readonly messageId: number }[],
  transaction?: Transaction
): Promise<number> => {
  if (keys.length === 0) return 0;
  return MessageMedia.destroy({
    where: { [Op.or]: keys.map((key) => ({ chatId: key.chatId, messageId: key.messageId })) },
    transaction,
  });
};

/**
 * Delete the picture rows of the given messages (the hourly message cleanup
 * cascades them with the message row).
 */
export const deleteMessageMediaForMessages = async (
  chatId: number,
  messageIds: readonly number[],
  transaction?: Transaction
): Promise<number> => {
  if (messageIds.length === 0) return 0;
  return MessageMedia.destroy({
    where: { chatId, messageId: { [Op.in]: [...messageIds] } },
    transaction,
  });
};
