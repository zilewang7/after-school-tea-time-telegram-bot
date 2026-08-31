/**
 * Telegram user roster queries: ingest-side upserts and the batched lookups
 * the context-time roster is built from.
 */
import { Op } from '@sequelize/core';
import { TelegramUser } from '../telegramUserDTO.js';

export interface TelegramUserInfo {
    userId: number;
    /** Handle without the leading @ (stored lowercased); null when absent */
    username?: string | null;
    firstName: string;
    lastName?: string | null;
}

/**
 * Record what a Telegram User object just told us about someone.
 * Read-compare-write: most messages change nothing, so the hot path stays a
 * single PK read. Failures only cost roster completeness — never the message.
 */
export const upsertTelegramUser = async (info: TelegramUserInfo): Promise<void> => {
    const username = info.username?.toLowerCase() ?? null;
    const lastName = info.lastName ?? null;
    try {
        const existing = await TelegramUser.findByPk(info.userId);
        if (
            existing &&
            existing.username === username &&
            existing.firstName === info.firstName &&
            existing.lastName === lastName
        ) {
            return;
        }
        await TelegramUser.upsert({
            userId: info.userId,
            username,
            firstName: info.firstName,
            lastName,
            updatedAt: new Date(),
        });
    } catch (error) {
        console.error(`[user-roster] upsert failed for ${info.userId}:`, error);
    }
};

/** Batched roster lookup by user id */
export const findTelegramUsersByIds = async (userIds: number[]): Promise<TelegramUser[]> => {
    if (!userIds.length) return [];
    return TelegramUser.findAll({ where: { userId: { [Op.in]: userIds } } });
};

/** Batched roster lookup by @handle (case-insensitive: stored lowercased) */
export const findTelegramUsersByUsernames = async (usernames: string[]): Promise<TelegramUser[]> => {
    if (!usernames.length) return [];
    return TelegramUser.findAll({
        where: { username: { [Op.in]: usernames.map((name) => name.toLowerCase()) } },
    });
};
