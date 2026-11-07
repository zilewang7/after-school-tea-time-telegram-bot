/**
 * Display names for user ids shown in the panel (audit actors, later issue
 * authors). The source is telegram_users, which every verified panel request
 * also refreshes; an id it does not know reads as 「用户 <id>」.
 */
import { findTelegramUsersByIds } from '../../db/queries/user-queries.js';
import { formatUserDisplayName } from '../../shared/user-display-name.js';

export type DisplayNames = ReadonlyMap<number, string>;

export const fallbackDisplayName = (userId: number): string => `用户 ${userId}`;

/** One batched lookup for every distinct id */
export const lookupDisplayNames = async (userIds: readonly number[]): Promise<DisplayNames> => {
    const distinctIds = [...new Set(userIds)];
    const users = await findTelegramUsersByIds(distinctIds);
    const names = new Map<number, string>();
    for (const user of users) {
        const trimmed = formatUserDisplayName(user).trim();
        if (trimmed.length > 0) names.set(user.userId, trimmed);
    }
    return names;
};

export const displayNameOf = (names: DisplayNames, userId: number): string =>
    names.get(userId) ?? fallbackDisplayName(userId);
