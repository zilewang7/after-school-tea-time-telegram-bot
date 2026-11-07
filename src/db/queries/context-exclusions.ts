/**
 * context_exclusions: the messages a chat's members took out of the model's
 * context. Read on every reply (getRepliesHistory), written from the panel.
 *
 * An exclusion and its audit row are written in one transaction. Writing what
 * is already there changes nothing and audits nothing, so a double click or a
 * retried request leaves one row and one audit entry.
 */
import { Op } from '@sequelize/core';
import { withBusyRetry } from '../busy-retry.js';
import { BotResponse } from '../botResponseDTO.js';
import { sequelize } from '../config.js';
import { ContextExclusion } from '../contextExclusionDTO.js';
import { Message } from '../messageDTO.js';
import { chatAuditScope, writeSettingsAudit } from './settings-audit.js';

export interface ExclusionRow {
    chatId: number;
    /** Canonical id: a bot reply's firstMessageId */
    messageId: number;
    createdAt: Date;
    createdBy: number;
}

export interface ExclusionWrite {
    chatId: number;
    /** Canonical id (the caller normalizes continuation ids) */
    messageId: number;
    actorId: number;
}

// A type alias, not an interface: Sequelize's where hash needs the implicit index signature
type MessageKey = {
    chatId: number;
    messageId: number;
};

/** Keys per query of the cleanup; two bound variables each */
const CLEANUP_CHUNK_SIZE = 200;

const toRow = (record: ContextExclusion): ExclusionRow => ({
    chatId: record.chatId,
    messageId: record.messageId,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
});

const keyOf = (key: MessageKey): string => `${key.chatId}:${key.messageId}`;

const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += size) {
        chunks.push(items.slice(start, start + size));
    }
    return chunks;
};

/** Every excluded message id of one chat */
export const listExcludedMessageIds = async (chatId: number): Promise<Set<number>> => {
    const rows = await ContextExclusion.findAll({ where: { chatId }, attributes: ['messageId'] });
    return new Set(rows.map((row) => row.messageId));
};

export const findExclusion = async (chatId: number, messageId: number): Promise<ExclusionRow | null> => {
    const record = await ContextExclusion.findOne({ where: { chatId, messageId } });
    return record === null ? null : toRow(record);
};

const insertExclusion = (input: ExclusionWrite): Promise<{ row: ExclusionRow; created: boolean }> =>
    sequelize.transaction(async (transaction) => {
        const existing = await ContextExclusion.findOne({
            where: { chatId: input.chatId, messageId: input.messageId },
            transaction,
        });
        if (existing !== null) return { row: toRow(existing), created: false };

        const record = await ContextExclusion.create(
            {
                chatId: input.chatId,
                messageId: input.messageId,
                createdAt: new Date(),
                createdBy: input.actorId,
            },
            { transaction }
        );
        await writeSettingsAudit(
            {
                actorId: input.actorId,
                scope: chatAuditScope(input.chatId),
                key: 'exclude',
                oldValue: null,
                newValue: String(input.messageId),
            },
            { transaction }
        );
        return { row: toRow(record), created: true };
    });

/**
 * Exclude one message. An existing exclusion comes back untouched with
 * `created: false` and no audit row; so does the loser of two concurrent
 * writes, whose insert hits the primary key.
 */
export const excludeMessage = async (input: ExclusionWrite): Promise<{ row: ExclusionRow; created: boolean }> => {
    try {
        return await withBusyRetry(
            () => insertExclusion(input),
            `context exclusion ${input.chatId}:${input.messageId}`
        );
    } catch (error) {
        const concurrent = await findExclusion(input.chatId, input.messageId);
        if (concurrent !== null) return { row: concurrent, created: false };
        throw error;
    }
};

/** Put one message back; false (and no audit row) when it was not excluded */
export const includeMessage = (input: ExclusionWrite): Promise<boolean> =>
    withBusyRetry(
        () =>
            sequelize.transaction(async (transaction) => {
                const removed = await ContextExclusion.destroy({
                    where: { chatId: input.chatId, messageId: input.messageId },
                    transaction,
                });
                if (removed === 0) return false;
                await writeSettingsAudit(
                    {
                        actorId: input.actorId,
                        scope: chatAuditScope(input.chatId),
                        key: 'include',
                        oldValue: null,
                        newValue: String(input.messageId),
                    },
                    { transaction }
                );
                return true;
            }),
        `context inclusion ${input.chatId}:${input.messageId}`
    );

/** Which of the keys still have a message row or a bot_responses row */
const liveKeysOf = async (keys: readonly MessageKey[]): Promise<Set<string>> => {
    const where = { [Op.or]: keys.map((key) => ({ chatId: key.chatId, messageId: key.messageId })) };
    const [messages, responses] = await Promise.all([
        Message.findAll({ where, attributes: ['chatId', 'messageId'] }),
        BotResponse.findAll({ where, attributes: ['chatId', 'messageId'] }),
    ]);
    return new Set([...messages, ...responses].map(keyOf));
};

/**
 * Hourly cleanup, after messages and bot responses have been purged: drop the
 * exclusions older than `olderThan` whose message is gone from both tables.
 * Returns how many rows were removed.
 */
export const purgeOrphanedExclusions = async (olderThan: Date): Promise<number> => {
    const candidates = await ContextExclusion.findAll({
        where: { createdAt: { [Op.lt]: olderThan } },
        attributes: ['chatId', 'messageId'],
    });
    if (candidates.length === 0) return 0;

    const orphaned: MessageKey[] = [];
    for (const chunk of chunksOf(candidates.map((row) => ({ chatId: row.chatId, messageId: row.messageId })), CLEANUP_CHUNK_SIZE)) {
        const live = await liveKeysOf(chunk);
        orphaned.push(...chunk.filter((key) => !live.has(keyOf(key))));
    }

    let removed = 0;
    for (const chunk of chunksOf(orphaned, CLEANUP_CHUNK_SIZE)) {
        removed += await ContextExclusion.destroy({ where: { [Op.or]: chunk } });
    }
    return removed;
};
