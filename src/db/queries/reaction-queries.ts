/**
 * message_reactions: the current reactions a message carries.
 *
 * Reads are used by the context builder (one batch per reply, keyed by the
 * messages the context really renders) and by the inbound handler (find the
 * canonical id a reaction belongs to). Writes are set-like: one actor's current
 * reaction set replaces that actor's previous rows; the bot's own reaction is
 * recorded locally because the Bot API never reports it as an update.
 *
 * Everything here keys rows by `(chatId, canonicalMessageId)`, the same pair a
 * context numbers by. A reaction for a message no table holds is dropped: a
 * later cleanup has no key to reap it with (the orphan sweep in §4.8 only
 * catches rows whose bot response disappeared later).
 */
import { Op, QueryTypes, type Transaction } from '@sequelize/core';
import { withBusyRetry } from '../busy-retry.js';
import { BotResponse } from '../botResponseDTO.js';
import { sequelize } from '../config.js';
import { findBotResponseByMessageId } from '../index.js';
import { Message } from '../messageDTO.js';
import { MessageReaction } from '../messageReactionDTO.js';

/** The three reaction variants the Bot API reports; the bot itself only sets standard emoji */
export type ReactionKind = 'emoji' | 'custom_emoji' | 'paid';

/** One reaction to write: what the actor's set holds, not a delta */
export interface ReactionInput {
    readonly kind: ReactionKind;
    /** Set when kind = 'emoji' */
    readonly emoji: string | null;
    /** Set when kind = 'custom_emoji' */
    readonly customEmojiId: string | null;
}

/** Who reacted: a user, or the anonymous chat (`actor_chat`) the update names */
export interface ReactionActor {
    readonly userId: number | null;
    readonly actorChatId: number | null;
    readonly userName: string | null;
}

/** One stored reaction, as the runtime block reads it */
export interface StoredReaction {
    readonly messageId: number;
    readonly userId: number | null;
    readonly actorChatId: number | null;
    readonly userName: string | null;
    readonly fromBotSelf: boolean;
    readonly kind: ReactionKind;
    readonly emoji: string | null;
    readonly customEmojiId: string | null;
    readonly createdAt: Date;
}

/** A message key the cleanup passes in, shaped like the other cascaded tables */
type MessageKey = {
    chatId: number;
    messageId: number;
};

/** Ids one IN list may carry; keeps the list well under SQLite's variable cap */
const BATCH_SIZE = 200;

/** `autoSave` stores a media group's 2nd+ item as this text; it never enters a context */
const SUB_IMAGE_TEXT_PATTERN = /sub image of \[(\d+)\]/;

/**
 * The canonical id an incoming reaction belongs to: a Message row's own id, the
 * parent of a `sub image of [...]` album item (that row is filtered out of
 * contexts), or the first message id of a bot reply. Null when no table holds
 * the message (cleaned up, a command message, a direct `ctx.api.send*` message).
 *
 * Deliberately a limited-column read: `getMessage` loads the whole row
 * including the multi-MB `file` BLOB.
 */
export const resolveReactionTargetId = async (
    chatId: number,
    messageId: number
): Promise<number | null> => {
    const message = await Message.findOne({
        where: { chatId, messageId },
        attributes: ['messageId', 'text', 'replyToId'],
    });
    if (message !== null) {
        const subImage = SUB_IMAGE_TEXT_PATTERN.exec(message.text ?? '');
        return subImage !== null && message.replyToId !== null ? message.replyToId : message.messageId;
    }
    const response = await findBotResponseByMessageId(chatId, messageId);
    return response === null ? null : response.messageId;
};

/** Which of the ids a table holds, both tables in one query each */
const existingCanonicalIds = async (
    chatId: number,
    messageIds: readonly number[],
    transaction: Transaction
): Promise<ReadonlySet<number>> => {
    const existing = new Set<number>();
    const messages = await Message.findAll({
        where: { chatId, messageId: { [Op.in]: [...messageIds] } },
        attributes: ['messageId'],
        transaction,
    });
    for (const message of messages) existing.add(message.messageId);
    const responses = await BotResponse.findAll({
        where: { chatId, messageId: { [Op.in]: [...messageIds] } },
        attributes: ['messageId'],
        transaction,
    });
    for (const response of responses) existing.add(response.messageId);
    return existing;
};

/** Whether the canonical id still has a row a context could read */
const canonicalMessageExists = async (
    chatId: number,
    messageId: number,
    transaction: Transaction
): Promise<boolean> =>
    (await existingCanonicalIds(chatId, [messageId], transaction)).has(messageId);

/** The bot's Telegram user id; rows are keyed by it so a display can mark them */
const botUserId = (): number | null => {
    const parsed = Number.parseInt(process.env.BOT_USER_ID ?? '', 10);
    return Number.isFinite(parsed) ? parsed : null;
};

/** One bot reaction the batch leaves on a canonical message; null emoji removes it */
export interface BotReactionReplacement {
    readonly canonicalMessageId: number;
    readonly emoji: string | null;
}

/**
 * Collapse repeated canonical ids: the last replacement wins but keeps the
 * first position, so the caller's own order still reads the way it was asked
 * for.
 */
const lastReplacementPerMessage = (
    items: readonly BotReactionReplacement[]
): readonly BotReactionReplacement[] => {
    const positionOf = new Map<number, number>();
    const replacements: BotReactionReplacement[] = [];
    for (const item of items) {
        const position = positionOf.get(item.canonicalMessageId);
        if (position === undefined) {
            positionOf.set(item.canonicalMessageId, replacements.length);
            replacements.push(item);
        } else {
            replacements[position] = item;
        }
    }
    return replacements;
};

/**
 * Replace the bot's own reactions on several canonical messages in one
 * transaction. Returns the emoji that stood on each before (null = there was
 * none, and also the answer for a message no table holds: such an item is not
 * written).
 *
 * The batch is one transaction on purpose: the existence check, the delete and
 * the insert may not be split by a cleanup, or a row would outlive the message
 * it hangs on. Callers cap the list at a handful of messages (react_to_message
 * allows six), so no chunking is needed.
 */
export const replaceBotReactions = async (
    chatId: number,
    items: readonly BotReactionReplacement[]
): Promise<Map<number, string | null>> => {
    const replacements = lastReplacementPerMessage(items);
    const previous = new Map<number, string | null>();
    for (const replacement of replacements) previous.set(replacement.canonicalMessageId, null);
    if (replacements.length === 0) return previous;

    const messageIds = replacements.map((replacement) => replacement.canonicalMessageId);
    const userId = botUserId();
    const userName = process.env.BOT_NAME || 'Bot';
    return withBusyRetry(
        () => sequelize.transaction(async (transaction) => {
            const existing = await existingCanonicalIds(chatId, messageIds, transaction);
            const storedIds = [...existing];
            if (storedIds.length > 0) {
                const previousRows = await MessageReaction.findAll({
                    where: { chatId, messageId: { [Op.in]: storedIds }, fromBotSelf: true },
                    attributes: ['messageId', 'emoji'],
                    transaction,
                });
                for (const row of previousRows) {
                    if (row.emoji !== null && previous.get(row.messageId) === null) {
                        previous.set(row.messageId, row.emoji);
                    }
                }
                await MessageReaction.destroy({
                    where: { chatId, messageId: { [Op.in]: storedIds }, fromBotSelf: true },
                    transaction,
                });
            }
            const newRows = replacements
                .filter((replacement) => replacement.emoji !== null && existing.has(replacement.canonicalMessageId))
                .map((replacement) => ({
                    chatId,
                    messageId: replacement.canonicalMessageId,
                    userId,
                    actorChatId: null,
                    userName,
                    fromBotSelf: true,
                    kind: 'emoji',
                    emoji: replacement.emoji,
                    customEmojiId: null,
                }));
            if (newRows.length > 0) await MessageReaction.bulkCreate(newRows, { transaction });
            return previous;
        }),
        `replace bot reactions ${chatId} (${replacements.length})`
    );
};

/**
 * Replace the bot's own reaction on one canonical message. Returns the emoji
 * that was there before, so the tool can say "replaced" or "already set".
 *
 * No-ops when no row holds the message (the caller may still have applied the
 * reaction through the Bot API — the DB is the model-facing copy, not the
 * source of truth).
 */
export const replaceBotReaction = async (
    chatId: number,
    canonicalMessageId: number,
    emoji: string | null
): Promise<{ previousEmoji: string | null }> => {
    const previous = await replaceBotReactions(chatId, [{ canonicalMessageId, emoji }]);
    return { previousEmoji: previous.get(canonicalMessageId) ?? null };
};

/**
 * Apply one `message_reaction` update: the actor's whole new set replaces its
 * previous rows. Resolves the canonical id first and silently drops a message no
 * table holds. `stored=false` means nothing was written (the caller only logs).
 */
export const applyUserReactionUpdate = async (change: {
    readonly chatId: number;
    /** The message id exactly as the update names it (may be a reply chunk) */
    readonly messageId: number;
    readonly actor: ReactionActor;
    readonly reactions: readonly ReactionInput[];
}): Promise<{ canonicalMessageId: number | null; stored: boolean }> => {
    const canonicalMessageId = await resolveReactionTargetId(change.chatId, change.messageId);
    if (canonicalMessageId === null) return { canonicalMessageId: null, stored: false };

    const { chatId } = change;
    const { actor } = change;
    const stored = await withBusyRetry(
        () => sequelize.transaction(async (transaction) => {
            if (!(await canonicalMessageExists(chatId, canonicalMessageId, transaction))) return false;
            // An anonymous actor has no user id; match on the chat it speaks for
            const actorWhere = actor.userId !== null
                ? { chatId, messageId: canonicalMessageId, userId: actor.userId, fromBotSelf: false }
                : {
                      chatId,
                      messageId: canonicalMessageId,
                      userId: { [Op.is]: null },
                      actorChatId: actor.actorChatId === null ? { [Op.is]: null } : actor.actorChatId,
                      fromBotSelf: false,
                  };
            await MessageReaction.destroy({ where: actorWhere, transaction });
            if (change.reactions.length > 0) {
                await MessageReaction.bulkCreate(
                    change.reactions.map((reaction) => ({
                        chatId,
                        messageId: canonicalMessageId,
                        userId: actor.userId,
                        actorChatId: actor.actorChatId,
                        userName: actor.userName,
                        fromBotSelf: false,
                        kind: reaction.kind,
                        emoji: reaction.emoji,
                        customEmojiId: reaction.customEmojiId,
                    })),
                    { transaction }
                );
            }
            return true;
        }),
        `reaction update ${chatId}/${canonicalMessageId}`
    );
    return { canonicalMessageId, stored };
};

/**
 * Resolve a message id and record the bot's reaction on its canonical row.
 * Never throws: callers are commands/easter eggs whose primary effect already
 * happened (or failed on its own).
 */
export const recordBotReaction = async (
    chatId: number,
    messageId: number,
    emoji: string
): Promise<boolean> => {
    try {
        const canonicalMessageId = await resolveReactionTargetId(chatId, messageId);
        if (canonicalMessageId === null) return false;
        await replaceBotReaction(chatId, canonicalMessageId, emoji);
        return true;
    } catch (error) {
        console.warn(
            `[reaction] failed to record the bot's reaction ${chatId}/${messageId}:`,
            error instanceof Error ? error.message : error
        );
        return false;
    }
};

/** Reactions on the given messages, in a stable order (message, age, actor) */
export const listReactionsForMessages = async (
    chatId: number,
    messageIds: readonly number[]
): Promise<StoredReaction[]> => {
    if (messageIds.length === 0) return [];
    const ids = [...new Set(messageIds)];
    const reactions: StoredReaction[] = [];
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
        const batch = ids.slice(start, start + BATCH_SIZE);
        const rows = await MessageReaction.findAll({
            where: { chatId, messageId: { [Op.in]: batch } },
            order: [
                ['messageId', 'ASC'],
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
        });
        for (const row of rows) {
            reactions.push({
                messageId: row.messageId,
                userId: row.userId,
                actorChatId: row.actorChatId,
                userName: row.userName,
                fromBotSelf: row.fromBotSelf,
                kind: isReactionKind(row.kind) ? row.kind : 'emoji',
                emoji: row.emoji,
                customEmojiId: row.customEmojiId,
                createdAt: row.createdAt,
            });
        }
    }
    return reactions;
};

const isReactionKind = (value: string): value is ReactionKind =>
    value === 'emoji' || value === 'custom_emoji' || value === 'paid';

/**
 * Delete the reactions of the given message keys. Called inside the cleanup's
 * transaction, with the keys the transaction re-read as still stale, so a row
 * cannot outlive its message.
 */
export const deleteReactionsForMessageKeys = async (
    keys: readonly MessageKey[],
    transaction: Transaction
): Promise<number> => {
    if (keys.length === 0) return 0;
    return MessageReaction.destroy({ where: { [Op.or]: [...keys] }, transaction });
};

/**
 * Reap rows the message-key cascade cannot see: a bot response that was
 * cleaned up before a Message row was ever written (a reply that failed
 * mid-stream), or a row inserted in the tiny window a cleanup committed in.
 * Run after the bot_responses cleanup, otherwise those rows look orphaned.
 */
export const deleteOrphanReactions = async (cutoff: Date): Promise<number> => {
    const orphanIds = await sequelize.query<{ id: number }>(
        `SELECT r.id AS id
           FROM message_reactions r
          WHERE r.createdAt < :cutoff
            AND NOT EXISTS (
                SELECT 1 FROM telegram_messages m
                 WHERE m.chatId = r.chatId AND m.messageId = r.messageId
            )
            AND NOT EXISTS (
                SELECT 1 FROM bot_responses b
                 WHERE b.chatId = r.chatId AND b.messageId = r.messageId
            )`,
        { replacements: { cutoff: cutoff.toISOString() }, type: QueryTypes.SELECT }
    );
    let deleted = 0;
    for (let start = 0; start < orphanIds.length; start += BATCH_SIZE) {
        const batch = orphanIds.slice(start, start + BATCH_SIZE).map((row) => row.id);
        deleted += await MessageReaction.destroy({ where: { id: { [Op.in]: batch } } });
    }
    return deleted;
};
