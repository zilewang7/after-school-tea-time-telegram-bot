/**
 * Display names for user ids shown in the panel (audit actors, issue authors,
 * access applicants). The source is telegram_users, which every verified panel
 * request also refreshes; an id it does not know reads as 「用户 <id>」.
 */
import { findTelegramUsersByIds } from '../../db/queries/user-queries.js';
import { formatUserDisplayName } from '../../shared/user-display-name.js';

export type DisplayNames = ReadonlyMap<number, string>;

export const fallbackDisplayName = (userId: number): string => `用户 ${userId}`;

/** A roster row as the panel shows it: the display name and the raw @handle */
export interface UserProfile {
    /** First + last name, or 「用户 <id>」 when the roster does not know them */
    readonly name: string;
    /** Without the @; null when the roster knows no handle */
    readonly username: string | null;
}

export type UserProfiles = ReadonlyMap<number, UserProfile>;

/** One batched lookup for every distinct id, name and @handle together */
export const lookupUserProfiles = async (userIds: readonly number[]): Promise<UserProfiles> => {
    const distinctIds = [...new Set(userIds)];
    const users = await findTelegramUsersByIds(distinctIds);
    const profiles = new Map<number, UserProfile>();
    for (const user of users) {
        const trimmed = formatUserDisplayName(user).trim();
        profiles.set(user.userId, {
            name: trimmed.length > 0 ? trimmed : fallbackDisplayName(user.userId),
            username: user.username ?? null,
        });
    }
    return profiles;
};

/** The profile, or the fallback name and no handle for an id the roster does not know */
export const userProfileOf = (profiles: UserProfiles, userId: number): UserProfile =>
    profiles.get(userId) ?? { name: fallbackDisplayName(userId), username: null };

/** One batched lookup for every distinct id */
export const lookupDisplayNames = async (userIds: readonly number[]): Promise<DisplayNames> => {
    const profiles = await lookupUserProfiles(userIds);
    const names = new Map<number, string>();
    for (const [userId, profile] of profiles) names.set(userId, profile.name);
    return names;
};

export const displayNameOf = (names: DisplayNames, userId: number): string =>
    names.get(userId) ?? fallbackDisplayName(userId);
