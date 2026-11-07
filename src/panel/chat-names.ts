/**
 * Names for chats the registry knows only by id.
 *
 * The first-deploy backfill seeded the chats table from stored messages, which
 * carry no titles. Harvested messages fill names in over time, but a quiet
 * chat would keep showing as a bare id. So after the panel starts, each
 * untitled chat is looked up once with getChat (a private chat falls back to
 * the bot's own user roster) and the name is kept in the registry. Best
 * effort: a chat that cannot be looked up stays untitled and is tried again on
 * the next start.
 */
import type { Api } from 'grammy';
import { isChatAllowed } from '../config/instance.js';
import { fillChatName, listUntitledChats, type ChatIdentity } from '../db/queries/panel-registry.js';
import { findTelegramUsersByIds } from '../db/queries/user-queries.js';
import { toTelegramApiAbortSignal } from '../services/telegram-file-service.js';

/** The fields of getChat's answer a name is built from; a grammy ChatFullInfo fits */
export interface ChatNameInfo {
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
}

/** getChat, or a stand-in in tests; must honour `signal` */
export type ChatNameLookup = (chatId: number, signal: AbortSignal) => Promise<ChatNameInfo>;

export interface FillChatNamesOptions {
    /** Per lookup; default 5s */
    timeoutMs?: number;
    /** Pause between lookups, far below Telegram's rate limits; default 200ms */
    gapMs?: number;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;
const DEFAULT_LOOKUP_GAP_MS = 200;

class ChatNameLookupTimeout extends Error {
    constructor(timeoutMs: number) {
        super(`no answer within ${timeoutMs}ms`);
        this.name = 'ChatNameLookupTimeout';
    }
}

/** The production lookup: getChat on the panel's own Api (no autoRetry) */
export const botApiChatNameLookup =
    (api: Api): ChatNameLookup =>
    (chatId, signal) =>
        api.getChat(chatId, toTelegramApiAbortSignal(signal));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lookupWithDeadline = async (
    lookup: ChatNameLookup,
    chatId: number,
    timeoutMs: number
): Promise<ChatNameInfo> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new ChatNameLookupTimeout(timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([lookup(chatId, controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

const identityOf = (chatId: number, info: ChatNameInfo): ChatIdentity => ({
    id: chatId,
    type: info.type,
    title: info.title,
    username: info.username,
    first_name: info.first_name,
    last_name: info.last_name,
});

/** A private chat's user as the roster knows them, for when Telegram will not say */
const rosterIdentityOf = async (chatId: number): Promise<ChatIdentity | null> => {
    const [user] = await findTelegramUsersByIds([chatId]);
    if (user === undefined) return null;
    return {
        id: chatId,
        type: 'private',
        first_name: user.firstName,
        last_name: user.lastName ?? undefined,
        username: user.username ?? undefined,
    };
};

/** True when the chat got a name */
const nameChat = async (chatId: number, lookup: ChatNameLookup, timeoutMs: number): Promise<boolean> => {
    try {
        const info = await lookupWithDeadline(lookup, chatId, timeoutMs);
        return await fillChatName(identityOf(chatId, info));
    } catch (error) {
        const fromRoster = chatId > 0 ? await rosterIdentityOf(chatId) : null;
        if (fromRoster !== null) return fillChatName(fromRoster);
        console.warn(`[panel] could not name chat ${chatId}: ${describeError(error)}`);
        return false;
    }
};

/** Look up every untitled chat this instance may show, one at a time */
export const fillMissingChatNames = async (
    lookup: ChatNameLookup,
    options: FillChatNamesOptions = {}
): Promise<void> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    const gapMs = options.gapMs ?? DEFAULT_LOOKUP_GAP_MS;
    // The test instance must not look up the production bot's chats
    const untitled = (await listUntitledChats()).filter((chat) => isChatAllowed(chat.chatId));
    if (untitled.length === 0) return;

    let named = 0;
    for (const [index, chat] of untitled.entries()) {
        if (index > 0) await sleep(gapMs);
        if (await nameChat(chat.chatId, lookup, timeoutMs)) named += 1;
    }
    console.log(`[panel] named ${named} of ${untitled.length} untitled chats`);
};
