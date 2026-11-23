/**
 * message_reactions: the current reactions one actor has on one Telegram message.
 *
 * Reads are used by the context builder (one batch per reply, keyed by the
 * canonical ids the context renders) and by the inbound handler (resolve the
 * message a reaction belongs to). Writes are set-like: one actor's current
 * reaction set on one source message replaces that actor's previous rows on the
 * same message; the bot's own reaction is recorded locally because the Bot API
 * never reports it as an update.
 *
 * Every row keeps two ids apart (design 2026-1123-1610):
 * - `messageId`: the canonical id a context numbers by (a bot reply's first
 *   message id), so rendering groups all parts of one reply under one `#N` and
 *   cleanup keys rows the way the other cascaded tables do;
 * - `sourceMessageId`: the message the user actually reacted to (a body chunk,
 *   picture, sticker, widget, folded link message, or a user message), so two
 *   different parts of one reply are independent states instead of overwriting
 *   each other. `part`/`partIndex` snapshot what that source was.
 *
 * A reaction for a message no table holds is dropped: a later cleanup has no key
 * to reap it with (the orphan sweep in §4.8 only catches rows whose bot response
 * disappeared later).
 */
import { Op, QueryTypes, type Transaction } from '@sequelize/core';
import { withBusyRetry } from '../busy-retry.js';
import { BotResponse } from '../botResponseDTO.js';
import { sequelize } from '../config.js';
import { findBotResponseByMessageId } from '../index.js';
import { Message } from '../messageDTO.js';
import { MessageReaction } from '../messageReactionDTO.js';
import { isReplyPartKind, type ReplyPartKind } from '../../shared/reply-part.js';
import { lookupReplyPart } from './reply-part-queries.js';

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
    /** Canonical id: the reply's first message id, or a user message's own id */
    readonly messageId: number;
    /** The message the actor actually reacted to (a reply part, or the message itself) */
    readonly sourceMessageId: number | null;
    /** Which part the source was; null for user messages, legacy rows and unknown ids */
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
    readonly userId: number | null;
    readonly actorChatId: number | null;
    readonly userName: string | null;
    readonly fromBotSelf: boolean;
    readonly kind: ReactionKind;
    readonly emoji: string | null;
    readonly customEmojiId: string | null;
    readonly createdAt: Date;
}

/**
 * Where one Telegram message id belongs: the reply a context numbers by, and the
 * part the message is. `sourceMessageId` is the id as the update named it.
 */
export interface ResolvedReactionTarget {
    readonly canonicalMessageId: number;
    readonly sourceMessageId: number;
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
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
 * The canonical id an incoming reaction belongs to, and which part of that reply
 * the message was (design §2.4):
 *
 * 1. the delivery ledger: every message a bot reply put in the chat, recorded as
 *    it was sent, so even a reaction arriving before finalize resolves;
 * 2. a `telegram_messages` row (user messages, bot notices): its own id, with an
 *    album sub-image normalized to its parent (only for rows that are not the
 *    bot's own — a bot body containing that text is not an album item);
 * 3. the versions fallback for replies delivered before the ledger existed (or
 *    whose ledger write failed): scan every version's message ids.
 *
 * Null when no table holds the message (cleaned up, a command message, a direct
 * `ctx.api.send*` message): such an update is skipped silently.
 */
export const resolveReactionTarget = async (
    chatId: number,
    messageId: number
): Promise<ResolvedReactionTarget | null> => {
    const ledger = await lookupReplyPart(chatId, messageId);
    if (ledger !== null) {
        return {
            canonicalMessageId: ledger.canonicalMessageId,
            sourceMessageId: messageId,
            part: ledger.part,
            partIndex: ledger.partIndex,
        };
    }

    // Deliberately a limited-column read: `getMessage` loads the whole row
    // including the multi-MB `file` BLOB.
    const message = await Message.findOne({
        where: { chatId, messageId },
        attributes: ['messageId', 'text', 'replyToId', 'fromBotSelf'],
    });
    if (message !== null) {
        const subImage = message.fromBotSelf ? null : SUB_IMAGE_TEXT_PATTERN.exec(message.text ?? '');
        const canonicalMessageId =
            subImage !== null && message.replyToId !== null ? message.replyToId : message.messageId;
        return { canonicalMessageId, sourceMessageId: messageId, part: null, partIndex: null };
    }

    const response = await findBotResponseByMessageId(chatId, messageId);
    if (response === null) return null;
    return {
        canonicalMessageId: response.messageId,
        sourceMessageId: messageId,
        part: null,
        partIndex: null,
    };
};

/** The canonical id alone, for callers that only need to know where it hangs */
export const resolveReactionTargetId = async (
    chatId: number,
    messageId: number
): Promise<number | null> => {
    const target = await resolveReactionTarget(chatId, messageId);
    return target === null ? null : target.canonicalMessageId;
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

/** The actor condition shared by the user-reaction delete and the bot replacement */
const actorWhereOf = (actor: ReactionActor): Record<string, unknown> =>
    actor.userId !== null
        ? { userId: actor.userId }
        : {
              userId: { [Op.is]: null },
              actorChatId: actor.actorChatId === null ? { [Op.is]: null } : actor.actorChatId,
          };

/** One bot reaction the batch leaves on a Telegram message; null emoji removes it */
export interface BotReactionReplacement {
    /** The reply's canonical id (the row's `messageId`) */
    readonly canonicalMessageId: number;
    readonly emoji: string | null;
    /** The message the bot reaction lands on; defaults to the canonical id */
    readonly sourceMessageId?: number;
    readonly part?: ReplyPartKind | null;
    readonly partIndex?: number | null;
}

/** One replacement after defaults are filled and repeated targets collapsed */
interface ResolvedBotReplacement {
    readonly canonicalMessageId: number;
    readonly sourceMessageId: number;
    readonly emoji: string | null;
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
}

/**
 * Collapse repeated targets (canonical id + source message): the last
 * replacement wins but keeps the first position, so the caller's own order still
 * reads the way it was asked for.
 */
const lastReplacementPerTarget = (
    items: readonly BotReactionReplacement[]
): readonly ResolvedBotReplacement[] => {
    const positionOf = new Map<string, number>();
    const replacements: ResolvedBotReplacement[] = [];
    for (const item of items) {
        const sourceMessageId = item.sourceMessageId ?? item.canonicalMessageId;
        const targetKey = `${item.canonicalMessageId}:${sourceMessageId}`;
        const resolved: ResolvedBotReplacement = {
            canonicalMessageId: item.canonicalMessageId,
            sourceMessageId,
            emoji: item.emoji,
            part: item.part ?? null,
            partIndex: item.partIndex ?? null,
        };
        const position = positionOf.get(targetKey);
        if (position === undefined) {
            positionOf.set(targetKey, replacements.length);
            replacements.push(resolved);
        } else {
            replacements[position] = resolved;
        }
    }
    return replacements;
};

/**
 * Replace the bot's own reactions on several messages in one transaction.
 * Returns the emoji that stood on each canonical message before (null = there
 * was none, and also the answer for a message no table holds: such an item is
 * not written).
 *
 * Replacement is per source message (the target the bot reaction lands on): a
 * row on another part of the same reply is another message and stays. Legacy bot
 * rows written before the parts model (part IS NULL) are superseded by the first
 * update on that reply.
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
    const replacements = lastReplacementPerTarget(items);
    const previous = new Map<number, string | null>();
    for (const replacement of replacements) previous.set(replacement.canonicalMessageId, null);
    if (replacements.length === 0) return previous;

    const canonicalIds = [...new Set(replacements.map((replacement) => replacement.canonicalMessageId))];
    const userId = botUserId();
    const userName = process.env.BOT_NAME || 'Bot';
    return withBusyRetry(
        () => sequelize.transaction(async (transaction) => {
            const existing = await existingCanonicalIds(chatId, canonicalIds, transaction);
            const previousRows = await MessageReaction.findAll({
                where: { chatId, messageId: { [Op.in]: [...canonicalIds] }, fromBotSelf: true },
                attributes: ['messageId', 'sourceMessageId', 'part', 'emoji'],
                transaction,
            });
            // The previous emoji is read from the same message the new one lands
            // on: two parts of one reply are independent bot reactions. A legacy
            // row (part IS NULL, written before the parts model) is the fallback.
            const previousByTarget = new Map<string, string>();
            const previousLegacy = new Map<number, string>();
            for (const row of previousRows) {
                if (row.emoji === null) continue;
                const targetKey = `${row.messageId}:${row.sourceMessageId}`;
                if (!previousByTarget.has(targetKey)) previousByTarget.set(targetKey, row.emoji);
                if (row.part === null && !previousLegacy.has(row.messageId)) {
                    previousLegacy.set(row.messageId, row.emoji);
                }
            }
            for (const replacement of replacements) {
                const current = previous.get(replacement.canonicalMessageId) ?? null;
                if (current !== null) continue;
                const sameTarget = previousByTarget.get(
                    `${replacement.canonicalMessageId}:${replacement.sourceMessageId}`
                );
                const previousEmoji = sameTarget ?? previousLegacy.get(replacement.canonicalMessageId) ?? null;
                previous.set(replacement.canonicalMessageId, previousEmoji);
            }

            for (const replacement of replacements) {
                if (!existing.has(replacement.canonicalMessageId)) continue;
                await MessageReaction.destroy({
                    where: {
                        chatId,
                        messageId: replacement.canonicalMessageId,
                        fromBotSelf: true,
                        [Op.or]: [
                            { sourceMessageId: replacement.sourceMessageId },
                            { part: { [Op.is]: null } },
                        ],
                    },
                    transaction,
                });
            }

            const newRows = replacements
                .filter(
                    (replacement) =>
                        replacement.emoji !== null && existing.has(replacement.canonicalMessageId)
                )
                .map((replacement) => ({
                    chatId,
                    messageId: replacement.canonicalMessageId,
                    sourceMessageId: replacement.sourceMessageId,
                    part: replacement.part,
                    partIndex: replacement.partIndex,
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

/** Where a bot reaction lands, when the caller already resolved it */
export interface BotReactionSource {
    readonly messageId: number;
    readonly part: ReplyPartKind | null;
    readonly partIndex: number | null;
}

/**
 * Replace the bot's own reaction on one canonical message. Returns the emoji
 * that was there before, so the tool can say "replaced" or "already set".
 *
 * No-ops when no row holds the message (the caller may still have applied the
 * reaction through the Bot API — the DB is the model-facing copy, not the source
 * of truth).
 */
export const replaceBotReaction = async (
    chatId: number,
    canonicalMessageId: number,
    emoji: string | null,
    source?: BotReactionSource
): Promise<{ previousEmoji: string | null }> => {
    const previous = await replaceBotReactions(chatId, [
        {
            canonicalMessageId,
            emoji,
            ...(source === undefined
                ? {}
                : { sourceMessageId: source.messageId, part: source.part, partIndex: source.partIndex }),
        },
    ]);
    return { previousEmoji: previous.get(canonicalMessageId) ?? null };
};

/**
 * Apply one `message_reaction` update: the actor's whole new set on one message
 * replaces its previous rows on that message. Resolves the target first and
 * silently drops a message no table holds. `stored=false` means nothing was
 * written (the caller only logs).
 *
 * The source message is what identifies the state: two parts of one reply never
 * overwrite each other. A legacy row of the same actor on the same reply (part
 * IS NULL, written before the parts model) is superseded by the first update.
 */
export const applyUserReactionUpdate = async (change: {
    readonly chatId: number;
    /** The message id exactly as the update names it (a reply part, or a user message) */
    readonly messageId: number;
    readonly actor: ReactionActor;
    readonly reactions: readonly ReactionInput[];
}): Promise<{ canonicalMessageId: number | null; stored: boolean }> => {
    const target = await resolveReactionTarget(change.chatId, change.messageId);
    if (target === null) return { canonicalMessageId: null, stored: false };

    const { chatId } = change;
    const { actor } = change;
    const stored = await withBusyRetry(
        () => sequelize.transaction(async (transaction) => {
            if (!(await canonicalMessageExists(chatId, target.canonicalMessageId, transaction))) return false;
            await MessageReaction.destroy({
                where: {
                    chatId,
                    messageId: target.canonicalMessageId,
                    fromBotSelf: false,
                    ...actorWhereOf(actor),
                    [Op.or]: [
                        { sourceMessageId: target.sourceMessageId },
                        { part: { [Op.is]: null } },
                    ],
                },
                transaction,
            });
            if (change.reactions.length > 0) {
                await MessageReaction.bulkCreate(
                    change.reactions.map((reaction) => ({
                        chatId,
                        messageId: target.canonicalMessageId,
                        sourceMessageId: target.sourceMessageId,
                        part: target.part,
                        partIndex: target.partIndex,
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
        `reaction update ${chatId}/${target.canonicalMessageId}`
    );
    return { canonicalMessageId: target.canonicalMessageId, stored };
};

/**
 * Resolve a message id and record the bot's reaction on its canonical row, with
 * the part snapshot. Never throws: callers are commands/easter eggs whose
 * primary effect already happened (or failed on its own).
 */
export const recordBotReaction = async (
    chatId: number,
    messageId: number,
    emoji: string
): Promise<boolean> => {
    try {
        const target = await resolveReactionTarget(chatId, messageId);
        if (target === null) return false;
        await replaceBotReaction(chatId, target.canonicalMessageId, emoji, {
            messageId: target.sourceMessageId,
            part: target.part,
            partIndex: target.partIndex,
        });
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
                sourceMessageId: row.sourceMessageId ?? null,
                part: isReplyPartKind(row.part) ? row.part : null,
                partIndex: row.partIndex ?? null,
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
