/**
 * The control panel's chat registry: which chats the bot has seen, and who has
 * spoken in which group.
 *
 * autoSave feeds it from every stored message through the debounced touches
 * (fire-and-forget, at most one write per chat / per member per 60s); `/panel`
 * and the panel's own private-chat access write right away. The panel reads it
 * to list chats and as the membership fallback when the Bot API cannot answer.
 *
 * Dates go through Sequelize replacements so they are stored in the same text
 * format as every model-written DATE column, which keeps comparisons and the
 * MIN/MAX of the backfill consistent.
 */
import { Op } from '@sequelize/core';
import type { Message as TgMessage } from 'grammy/types';
import { match } from 'ts-pattern';
import { sequelize } from '../config.js';
import { ChatRecord } from '../chatDTO.js';
import { ChatMemberSeen } from '../chatMemberSeenDTO.js';
import { upsertTelegramUser } from './user-queries.js';

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface ChatRow {
    chatId: number;
    type: ChatType;
    title: string | null;
    username: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

/** The fields of a Telegram Chat the registry stores; a grammy `Chat` fits */
export interface ChatIdentity {
    id: number;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
}

export interface PanelUserIdentity {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}

/** One write per chat, per member and per panel user within this window */
const TOUCH_INTERVAL_MS = 60_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Supergroup and channel ids are -100 followed by the internal id */
const SUPERGROUP_ID_UPPER_BOUND = -1_000_000_000_000;

/** Telegram's service account: forwards from linked channels arrive as it */
const TELEGRAM_SERVICE_USER_ID = 777000;

/** GroupAnonymousBot: an anonymous admin, not an identifiable person */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/** Same rule as the backfill: by sign, then by the -100 prefix */
const chatTypeFromId = (chatId: number): ChatType => {
    if (chatId > 0) return 'private';
    return chatId <= SUPERGROUP_ID_UPPER_BOUND ? 'supergroup' : 'group';
};

const normalizeChatType = (type: string, chatId: number): ChatType =>
    match(type)
        .with('private', 'group', 'supergroup', 'channel', (known) => known)
        .otherwise(() => chatTypeFromId(chatId));

/** "First Last", or just the first name */
const fullNameOf = (firstName: string, lastName: string | undefined): string =>
    lastName === undefined || lastName === '' ? firstName : `${firstName} ${lastName}`;

/** A private chat is titled with the user's full name, everything else with its title */
const chatTitleOf = (chat: ChatIdentity, type: ChatType): string | null => {
    if (type !== 'private') return chat.title ?? null;
    return chat.first_name === undefined ? null : fullNameOf(chat.first_name, chat.last_name);
};

const toChatRow = (record: ChatRecord): ChatRow => ({
    chatId: record.chatId,
    type: normalizeChatType(record.type, record.chatId),
    title: record.title,
    username: record.username,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
});

/**
 * Insert or refresh one chats row. A missing title never wipes a known one;
 * the username always follows the latest Chat object, NULL included.
 */
const upsertChatRow = async (chat: ChatIdentity, seenAt: Date): Promise<void> => {
    const type = normalizeChatType(chat.type, chat.id);
    await sequelize.query(
        `INSERT INTO chats (chatId, type, title, username, firstSeenAt, lastSeenAt)
         VALUES (:chatId, :type, :title, :username, :seenAt, :seenAt)
         ON CONFLICT(chatId) DO UPDATE SET
             type = excluded.type,
             title = COALESCE(excluded.title, chats.title),
             username = excluded.username,
             lastSeenAt = excluded.lastSeenAt`,
        {
            replacements: {
                chatId: chat.id,
                type,
                title: chatTitleOf(chat, type),
                username: chat.username ?? null,
                seenAt,
            },
        }
    );
};

/**
 * Add `count` messages to a member row, creating it on first sight.
 * firstSeenAt is only ever set by the insert.
 */
const upsertMemberRow = async (
    chatId: number,
    userId: number,
    count: number,
    seenAt: Date
): Promise<void> => {
    await sequelize.query(
        `INSERT INTO chat_members_seen (chatId, userId, firstSeenAt, lastSeenAt, messageCount)
         VALUES (:chatId, :userId, :seenAt, :seenAt, :count)
         ON CONFLICT(chatId, userId) DO UPDATE SET
             lastSeenAt = excluded.lastSeenAt,
             messageCount = chat_members_seen.messageCount + excluded.messageCount`,
        { replacements: { chatId, userId, count, seenAt } }
    );
};

/** Last write start per chat id (ms) */
const chatTouchTimes = new Map<number, number>();

/** Immediate upsert, used by `/panel` right before it answers */
export const upsertChatNow = async (chat: ChatIdentity): Promise<void> => {
    const now = Date.now();
    await upsertChatRow(chat, new Date(now));
    chatTouchTimes.set(chat.id, now);
};

/**
 * Leading-edge throttle: the first call writes, later calls within 60s are
 * dropped (lastSeenAt is therefore up to 60s stale, and a title change waits
 * for the next write). A failed write clears the stamp so the next message
 * retries. Never throws.
 */
export const touchChatDebounced = (chat: ChatIdentity): void => {
    const now = Date.now();
    const lastTouchedAt = chatTouchTimes.get(chat.id);
    if (lastTouchedAt !== undefined && now - lastTouchedAt < TOUCH_INTERVAL_MS) return;
    chatTouchTimes.set(chat.id, now);
    upsertChatRow(chat, new Date(now)).catch((error: unknown) => {
        chatTouchTimes.delete(chat.id);
        console.error(`[panel-registry] chat upsert failed for ${chat.id}:`, error);
    });
};

interface MemberTouchState {
    /** When the last write started (ms); 0 = never */
    lastWriteAt: number;
    /** Calls not written yet: dropped by the throttle, or put back after a failure */
    pendingCount: number;
}

/** Keyed by `chatId:userId` */
const memberTouches = new Map<string, MemberTouchState>();

/**
 * Record that a person spoke in a group. Private chats (positive ids) are
 * ignored; the caller filters out non-human senders.
 *
 * Semantics: every call counts one message. The first call writes at once and
 * opens a 60s window; calls inside the window only add to an in-memory pending
 * count, which the first call after the window writes together with itself.
 * So lastSeenAt moves at most once per 60s (up to 60s stale), and messageCount
 * is exact except for the pending calls of a member who has not spoken since,
 * which a restart loses: it is a lower bound. A failed write puts its count
 * back and lets the next call retry. Never throws.
 */
export const touchChatMemberDebounced = (chatId: number, userId: number): void => {
    if (chatId >= 0) return;
    const key = `${chatId}:${userId}`;
    const now = Date.now();
    const state = memberTouches.get(key) ?? { lastWriteAt: 0, pendingCount: 0 };
    memberTouches.set(key, state);
    state.pendingCount += 1;
    if (now - state.lastWriteAt < TOUCH_INTERVAL_MS) return;

    const count = state.pendingCount;
    state.pendingCount = 0;
    state.lastWriteAt = now;
    upsertMemberRow(chatId, userId, count, new Date(now)).catch((error: unknown) => {
        state.pendingCount += count;
        state.lastWriteAt = 0;
        console.error(`[panel-registry] member upsert failed for ${key}:`, error);
    });
};

/**
 * The person behind a group message, or null when the message does not come
 * from an identifiable human: private chats and channels, bots, messages sent
 * as a chat (anonymous admins, channel posts), GroupAnonymousBot and the
 * Telegram service account.
 */
const humanGroupSenderId = (message: TgMessage): number | null => {
    if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return null;
    if (message.sender_chat) return null;
    const from = message.from;
    if (!from || from.is_bot) return null;
    if (from.id === TELEGRAM_SERVICE_USER_ID || from.id === GROUP_ANONYMOUS_BOT_ID) return null;
    return from.id;
};

/**
 * autoSave's hook, next to the user roster: register the chat and, in groups,
 * the human sender. Fire-and-forget; never throws into the ingest path.
 */
export const harvestChatRegistry = (message: TgMessage | undefined): void => {
    if (!message) return;
    try {
        touchChatDebounced(message.chat);
        const senderId = humanGroupSenderId(message);
        if (senderId !== null) touchChatMemberDebounced(message.chat.id, senderId);
    } catch (error) {
        console.error('[panel-registry] harvest failed:', error);
    }
};

export const findChat = async (chatId: number): Promise<ChatRow | null> => {
    const record = await ChatRecord.findByPk(chatId);
    return record ? toChatRow(record) : null;
};

/** Every known chat, most recently active first */
export const listChats = async (): Promise<ChatRow[]> => {
    const records = await ChatRecord.findAll({ order: [['lastSeenAt', 'DESC']] });
    return records.map(toChatRow);
};

/** Groups the user has spoken in (never cleaned), most recent first */
export const listGroupChatIdsSpokenIn = async (userId: number): Promise<number[]> => {
    const rows = await ChatMemberSeen.findAll({
        where: { userId },
        attributes: ['chatId'],
        order: [['lastSeenAt', 'DESC']],
    });
    return rows.map((row) => row.chatId);
};

/** Whether the user spoke in the group within the last `days` days */
export const spokeWithinDays = async (chatId: number, userId: number, days: number): Promise<boolean> => {
    const cutoff = new Date(Date.now() - days * MILLISECONDS_PER_DAY);
    const row = await ChatMemberSeen.findOne({
        where: { chatId, userId, lastSeenAt: { [Op.gte]: cutoff } },
        attributes: ['chatId'],
    });
    return row !== null;
};

/** Chats known only by id: seeded by the first-deploy backfill and not named since */
export const listUntitledChats = async (): Promise<ChatRow[]> => {
    const records = await ChatRecord.findAll({ where: { title: null }, order: [['chatId', 'ASC']] });
    return records.map(toChatRow);
};

/**
 * Name an untitled chat from a Chat object fetched for the purpose (getChat,
 * or the roster for a private chat). Only rows still without a title are
 * written: a message harvested meanwhile carries fresher data. False when the
 * object holds no name to give.
 */
export const fillChatName = async (chat: ChatIdentity): Promise<boolean> => {
    const type = normalizeChatType(chat.type, chat.id);
    const title = chatTitleOf(chat, type);
    if (title === null) return false;
    await sequelize.query(
        `UPDATE chats SET type = :type, title = :title, username = :username
         WHERE chatId = :chatId AND title IS NULL`,
        { replacements: { chatId: chat.id, type, title, username: chat.username ?? null } }
    );
    return true;
};

/** Private chats already ensured by this process, so repeat requests skip the write */
const ensuredPrivateChats = new Set<number>();

/**
 * Make sure a user's own private chat has a chats row, created from initData
 * when they open the panel before ever writing to the bot. An existing row
 * keeps its data; one seeded by the backfill (no title yet) gets the name.
 */
export const ensurePrivateChatRow = async (user: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}): Promise<void> => {
    if (ensuredPrivateChats.has(user.id)) return;
    const now = new Date();
    await sequelize.query(
        `INSERT INTO chats (chatId, type, title, username, firstSeenAt, lastSeenAt)
         VALUES (:chatId, 'private', :title, :username, :now, :now)
         ON CONFLICT(chatId) DO UPDATE SET
             title = excluded.title,
             username = excluded.username
         WHERE chats.title IS NULL`,
        {
            replacements: {
                chatId: user.id,
                title: fullNameOf(user.first_name, user.last_name),
                username: user.username ?? null,
                now,
            },
        }
    );
    ensuredPrivateChats.add(user.id);
};

/** Last roster write per panel user id (ms) */
const panelUserTouchTimes = new Map<number, number>();

/**
 * Keep the panel user's display name in telegram_users: members who only use
 * the panel never appear as message authors. At most one write per user per
 * 60s; the roster upsert itself never throws.
 */
export const touchPanelUserDebounced = (user: PanelUserIdentity): void => {
    const now = Date.now();
    const lastTouchedAt = panelUserTouchTimes.get(user.id);
    if (lastTouchedAt !== undefined && now - lastTouchedAt < TOUCH_INTERVAL_MS) return;
    panelUserTouchTimes.set(user.id, now);
    void upsertTelegramUser({
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        isBot: false,
    });
};
