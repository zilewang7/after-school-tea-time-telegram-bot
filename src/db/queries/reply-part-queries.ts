/**
 * Reads and writes of the reply delivery ledger (`bot_reply_messages`).
 *
 * The delivery writes one row per message it puts in the chat, as soon as the
 * message exists (so a reaction arriving before finalize still normalizes); the
 * inbound reaction path reads it to learn which reply and which part a bare
 * message id belongs to. Reads are tolerant: a row whose part is not a known
 * kind is treated as unknown instead of failing the update.
 */
import { Op, QueryTypes, type Transaction } from '@sequelize/core';
import { BotReplyMessage } from '../botReplyMessageDTO.js';
import { sequelize } from '../config.js';
import { isReplyPartKind, type ReplyPartKind } from '../../shared/reply-part.js';

/** A message key the cleanup passes in, shaped like the other cascaded tables */
type MessageKey = {
    chatId: number;
    messageId: number;
};

/** One part of a reply as the ledger stores it */
export interface StoredReplyPart {
    readonly chatId: number;
    readonly messageId: number;
    readonly canonicalMessageId: number;
    readonly part: ReplyPartKind;
    readonly partIndex: number | null;
}

/** What the inbound path needs: which reply a message part belongs to */
export interface ReplyPartLookup {
    readonly canonicalMessageId: number;
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
}

/** Ids one IN list may carry; keeps the list well under SQLite's variable cap */
const BATCH_SIZE = 200;

/** The kind a stored string names, if it is still one this code knows */
const knownPartOf = (value: string): ReplyPartKind | null =>
    isReplyPartKind(value) ? value : null;

/** One row as the runtime block and the inbound path read it */
const storedPartOf = (row: BotReplyMessage): StoredReplyPart | null => {
    const part = knownPartOf(row.part);
    if (part === null) return null;
    return {
        chatId: row.chatId,
        messageId: row.messageId,
        canonicalMessageId: row.canonicalMessageId,
        part,
        partIndex: row.partIndex ?? null,
    };
};

/**
 * Write (or refresh) the ledger row of one message. find-then-update, the table
 * convention here: the final layout and a version switch lay the same message
 * out again, and its part must follow the layout now on screen.
 */
export const setReplyPart = async (input: {
    readonly chatId: number;
    readonly canonicalMessageId: number;
    readonly messageId: number;
    readonly part: ReplyPartKind;
    readonly partIndex?: number | null;
}): Promise<void> => {
    const partIndex = input.partIndex ?? null;
    const existing = await BotReplyMessage.findOne({
        where: { chatId: input.chatId, messageId: input.messageId },
    });
    if (existing !== null) {
        existing.set({
            canonicalMessageId: input.canonicalMessageId,
            part: input.part,
            partIndex,
        });
        await existing.save();
        return;
    }
    await BotReplyMessage.create({
        chatId: input.chatId,
        messageId: input.messageId,
        canonicalMessageId: input.canonicalMessageId,
        part: input.part,
        partIndex,
    });
};

/**
 * Append one body segment: the index continues the reply's existing body rows.
 * A streamed continuation has no ordinal of its own, so the ledger counts it.
 */
export const appendBodyPart = async (
    chatId: number,
    canonicalMessageId: number,
    messageId: number
): Promise<void> => {
    const last = await BotReplyMessage.findOne({
        where: { chatId, canonicalMessageId, part: 'body' },
        attributes: ['partIndex'],
        order: [['partIndex', 'DESC']],
    });
    const partIndex = (last?.partIndex ?? 0) + 1;
    await setReplyPart({ chatId, canonicalMessageId, messageId, part: 'body', partIndex });
};

/** Which reply and part a Telegram message id belongs to; null when unknown */
export const lookupReplyPart = async (
    chatId: number,
    messageId: number
): Promise<ReplyPartLookup | null> => {
    const row = await BotReplyMessage.findOne({ where: { chatId, messageId } });
    if (row === null) return null;
    return {
        canonicalMessageId: row.canonicalMessageId,
        part: knownPartOf(row.part),
        partIndex: row.partIndex ?? null,
    };
};

/** Drop one message's row (the message was actually deleted) */
export const removeReplyPart = async (chatId: number, messageId: number): Promise<number> => {
    return BotReplyMessage.destroy({ where: { chatId, messageId } });
};

/**
 * Delete the ledger rows that hang on deleted messages: by the part's own id and
 * by the reply's canonical id (the cleanup deletes a bot message row under the
 * first id, but the parts rarely have rows of their own).
 */
export const deleteReplyPartsForMessageKeys = async (
    keys: readonly MessageKey[],
    transaction: Transaction
): Promise<number> => {
    if (keys.length === 0) return 0;
    return BotReplyMessage.destroy({
        where: {
            [Op.or]: [
                ...keys.map((key) => ({ chatId: key.chatId, messageId: key.messageId })),
                ...keys.map((key) => ({
                    chatId: key.chatId,
                    canonicalMessageId: key.messageId,
                })),
            ],
        },
        transaction,
    });
};

/** Delete every part of one reply (after the bot response row is gone) */
export const deleteReplyPartsForCanonical = async (
    chatId: number,
    canonicalMessageId: number,
    transaction?: Transaction
): Promise<number> => {
    return BotReplyMessage.destroy({
        where: { chatId, canonicalMessageId },
        ...(transaction === undefined ? {} : { transaction }),
    });
};

/**
 * Reap rows the cascades cannot see: the canonical reply is gone and the part
 * message never had a row of its own (a crashed reply, or a version switch that
 * deleted the message). Run after the bot_responses cleanup, otherwise those
 * rows look orphaned.
 */
export const deleteOrphanReplyParts = async (cutoff: Date): Promise<number> => {
    const orphanIds = await sequelize.query<{ id: number }>(
        `SELECT p.id AS id
           FROM bot_reply_messages p
          WHERE p.createdAt < :cutoff
            AND NOT EXISTS (
                SELECT 1 FROM bot_responses b
                 WHERE b.chatId = p.chatId AND b.messageId = p.canonicalMessageId
            )
            AND NOT EXISTS (
                SELECT 1 FROM telegram_messages m
                 WHERE m.chatId = p.chatId AND m.messageId = p.messageId
            )`,
        { replacements: { cutoff: cutoff.toISOString() }, type: QueryTypes.SELECT }
    );
    let deleted = 0;
    for (let start = 0; start < orphanIds.length; start += BATCH_SIZE) {
        const batch = orphanIds.slice(start, start + BATCH_SIZE).map((row) => row.id);
        deleted += await BotReplyMessage.destroy({ where: { id: { [Op.in]: batch } } });
    }
    return deleted;
};

/** Every part of one reply, in writing order (diagnostics / future panel use) */
export const listReplyPartsForCanonical = async (
    chatId: number,
    canonicalMessageId: number
): Promise<StoredReplyPart[]> => {
    const rows = await BotReplyMessage.findAll({
        where: { chatId, canonicalMessageId },
        order: [['id', 'ASC']],
    });
    return rows.flatMap((row) => {
        const part = storedPartOf(row);
        return part === null ? [] : [part];
    });
};
