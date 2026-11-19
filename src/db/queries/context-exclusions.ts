/**
 * context_exclusions: the messages a chat's members took out of the model's
 * context. Read on every reply (getRepliesHistory), written from the panel.
 *
 * An exclusion and its audit row are written in one transaction. Writing what
 * is already there changes nothing and audits nothing, so a double click or a
 * retried request leaves one row and one audit entry.
 */
import { Op, type Transaction } from '@sequelize/core';
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

/** Ids per query and per insert of a batch write */
const BATCH_CHUNK_SIZE = 200;

/** One batch write from the panel: ids already canonical and deduplicated */
export interface ExclusionBatchWrite {
    chatId: number;
    messageIds: readonly number[];
    actorId: number;
}

export interface ExclusionBatchResult {
    /** Ids whose state changed, in input order */
    changed: number[];
    /** Ids that were already in the target state, in input order */
    unchanged: number[];
}

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

/** Which of the ids already have an exclusion row, read in chunks */
const findExcludedIds = async (
    chatId: number,
    messageIds: readonly number[],
    transaction?: Transaction
): Promise<Set<number>> => {
    const excluded = new Set<number>();
    for (const chunk of chunksOf(messageIds, BATCH_CHUNK_SIZE)) {
        const rows = await ContextExclusion.findAll({
            where: { chatId, messageId: { [Op.in]: chunk } },
            attributes: ['messageId'],
            ...(transaction !== undefined ? { transaction } : {}),
        });
        for (const row of rows) excluded.add(row.messageId);
    }
    return excluded;
};

/** Write the exclusion rows and one audit row each, all in the caller's transaction */
const insertExclusions = async (input: ExclusionBatchWrite, transaction: Transaction): Promise<void> => {
    const createdAt = new Date();
    for (const chunk of chunksOf(input.messageIds, BATCH_CHUNK_SIZE)) {
        await ContextExclusion.bulkCreate(
            chunk.map((messageId) => ({ chatId: input.chatId, messageId, createdAt, createdBy: input.actorId })),
            { transaction }
        );
        for (const messageId of chunk) {
            await writeSettingsAudit(
                {
                    actorId: input.actorId,
                    scope: chatAuditScope(input.chatId),
                    key: 'exclude',
                    oldValue: null,
                    newValue: String(messageId),
                },
                { transaction }
            );
        }
    }
};

const excludeBatch = (input: ExclusionBatchWrite): Promise<ExclusionBatchResult> =>
    sequelize.transaction(async (transaction) => {
        const existing = await findExcludedIds(input.chatId, input.messageIds, transaction);
        const changed = input.messageIds.filter((messageId) => !existing.has(messageId));
        if (changed.length === 0) return { changed: [], unchanged: [...input.messageIds] };
        await insertExclusions({ ...input, messageIds: changed }, transaction);
        return { changed, unchanged: input.messageIds.filter((messageId) => existing.has(messageId)) };
    });

/**
 * Exclude many messages at once. One transaction, one audit row per changed id
 * (same key and value as `excludeMessage`); ids already excluded come back
 * unchanged and audit nothing. A primary-key conflict with a concurrent writer
 * is resolved like `excludeMessage`: look up what it wrote, then write the rest.
 */
export const excludeMany = async (input: ExclusionBatchWrite): Promise<ExclusionBatchResult> => {
    if (input.messageIds.length === 0) return { changed: [], unchanged: [] };
    const description = `context exclusions ${input.chatId} (${input.messageIds.length})`;
    try {
        return await withBusyRetry(() => excludeBatch(input), description);
    } catch (error) {
        const concurrent = await findExcludedIds(input.chatId, input.messageIds);
        if (concurrent.size === 0) throw error;
        const remaining = input.messageIds.filter((messageId) => !concurrent.has(messageId));
        if (remaining.length === 0) return { changed: [], unchanged: [...input.messageIds] };
        const retried = await excludeBatch({ ...input, messageIds: remaining });
        const retriedUnchanged = new Set(retried.unchanged);
        return {
            changed: retried.changed,
            unchanged: input.messageIds.filter(
                (messageId) => concurrent.has(messageId) || retriedUnchanged.has(messageId)
            ),
        };
    }
};

const includeBatch = (input: ExclusionBatchWrite): Promise<ExclusionBatchResult> =>
    sequelize.transaction(async (transaction) => {
        const existing = await findExcludedIds(input.chatId, input.messageIds, transaction);
        const changed = input.messageIds.filter((messageId) => existing.has(messageId));
        if (changed.length === 0) return { changed: [], unchanged: [...input.messageIds] };
        for (const chunk of chunksOf(changed, BATCH_CHUNK_SIZE)) {
            await ContextExclusion.destroy({
                where: { chatId: input.chatId, messageId: { [Op.in]: chunk } },
                transaction,
            });
            for (const messageId of chunk) {
                await writeSettingsAudit(
                    {
                        actorId: input.actorId,
                        scope: chatAuditScope(input.chatId),
                        key: 'include',
                        oldValue: null,
                        newValue: String(messageId),
                    },
                    { transaction }
                );
            }
        }
        return { changed, unchanged: input.messageIds.filter((messageId) => !existing.has(messageId)) };
    });

/** Put many messages back at once; ids that were not excluded come back unchanged */
export const includeMany = (input: ExclusionBatchWrite): Promise<ExclusionBatchResult> => {
    if (input.messageIds.length === 0) return Promise.resolve({ changed: [], unchanged: [] });
    return withBusyRetry(
        () => includeBatch(input),
        `context inclusions ${input.chatId} (${input.messageIds.length})`
    );
};

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
