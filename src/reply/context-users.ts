/**
 * Collect the user roster of one assembled context: message authors plus users
 * mentioned in the texts, resolved against the telegram_users table. The
 * roster goes into the system prompt so the model can mention (@) people
 * correctly; the messages themselves keep carrying only the first name.
 */
import {
    findTelegramUsersByIds,
    findTelegramUsersByUsernames,
} from '../db/queries/user-queries.js';
import type { ContextMessage } from '../db/queries/context-queries.js';
import type { ContextUser } from '../ai/types.js';

export type { ContextUser };

/** text_mention entities are stored as markdown links to tg://user?id=N */
const TEXT_MENTION_PATTERN = /\[([^\]]+)\]\(tg:\/\/user\?id=(\d+)\)/g;
/**
 * Plain-text @handle. Telegram handles are 4-32 chars of [A-Za-z0-9_]; the
 * char before the @ must not be a word char, so emails don't match.
 */
const HANDLE_PATTERN = /(?<![\w@])@([A-Za-z0-9_]{4,32})\b/g;

/** forwardOrigin renders a user forward as "user 张三"; recover the bare name */
const forwardedName = (forwardOrigin: string | null): string =>
    forwardOrigin?.replace(/^user /, '') ?? '';

export const collectContextUsers = async (
    contextMessages: ContextMessage[]
): Promise<ContextUser[]> => {
    // Authors: last write wins so the freshest first name sticks
    const authorNameById = new Map<number, string>();
    // Mentioned users found as tg://user links (id + display name in the text)
    const mentionNameById = new Map<number, string>();
    const mentionedHandles = new Set<string>();

    for (const msg of contextMessages) {
        if (!msg.fromBotSelf && msg.userId !== null) {
            authorNameById.set(msg.userId, msg.userName);
        }
        // The original sender of a forwarded message counts as mentioned: the
        // conversation is literally about their words
        if (msg.forwardFromId !== null) {
            mentionNameById.set(msg.forwardFromId, forwardedName(msg.forwardOrigin));
        }
        if (!msg.text) continue;
        for (const match of msg.text.matchAll(TEXT_MENTION_PATTERN)) {
            mentionNameById.set(Number(match[2]), match[1] ?? '');
        }
        for (const match of msg.text.matchAll(HANDLE_PATTERN)) {
            mentionedHandles.add(match[1]!.toLowerCase());
        }
    }

    const idsToLookUp = [...new Set([...authorNameById.keys(), ...mentionNameById.keys()])];
    const [byIdRows, byHandleRows] = await Promise.all([
        findTelegramUsersByIds(idsToLookUp),
        findTelegramUsersByUsernames([...mentionedHandles]),
    ]);
    const rosterById = new Map(byIdRows.map((row) => [row.userId, row]));

    const users: ContextUser[] = [];
    const seenIds = new Set<number>();
    const seenHandles = new Set<string>();

    const pushEntry = (
        userId: number,
        fallbackName: string,
        mentionedOnly: boolean
    ): void => {
        if (seenIds.has(userId)) return;
        seenIds.add(userId);
        const roster = rosterById.get(userId);
        if (roster?.username) seenHandles.add(roster.username);
        users.push({
            userId,
            username: roster?.username ?? undefined,
            firstName: roster?.firstName ?? fallbackName,
            lastName: roster?.lastName ?? undefined,
            mentionedOnly,
        });
    };

    // Authors first (the people actually talking), then link-mentioned users
    for (const [userId, name] of authorNameById) {
        pushEntry(userId, name, false);
    }
    for (const [userId, name] of mentionNameById) {
        pushEntry(userId, name, true);
    }

    // @handle mentions: only worth a roster line when the handle resolves to a
    // record — a bare handle the model can already read adds no information
    for (const row of byHandleRows) {
        if (seenIds.has(row.userId) || !row.username || seenHandles.has(row.username)) continue;
        seenIds.add(row.userId);
        users.push({
            userId: row.userId,
            username: row.username,
            firstName: row.firstName,
            lastName: row.lastName ?? undefined,
            mentionedOnly: true,
        });
    }

    return users;
};
