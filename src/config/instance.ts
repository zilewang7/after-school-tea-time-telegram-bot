/**
 * Instance-role configuration (production vs test bot).
 *
 * TEST_INSTANCE=1 marks the dev/test container (@WatchFirstBot): it drops
 * pending updates on startup, registers commands only for its allowed chat,
 * skips global profile descriptions and cleans up commands on shutdown, so
 * the shared production group never sees the test bot's commands.
 *
 * ALLOWED_CHAT_IDS (comma-separated) restricts which chats the bot reacts
 * to at all; unset/empty = no restriction (production behavior).
 */
export const isTestInstance = (): boolean => process.env.TEST_INSTANCE === '1';

const parseAllowedChatIds = (): number[] | null => {
    const raw = process.env.ALLOWED_CHAT_IDS;
    if (!raw) return null;
    const ids = raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isFinite(id) && id !== 0);
    return ids.length ? ids : null;
};

const allowedChatIds = parseAllowedChatIds();

/** null = unrestricted */
export const getAllowedChatIds = (): number[] | null => allowedChatIds;

export const isChatAllowed = (chatId: number | undefined): boolean => {
    if (allowedChatIds === null) return true;
    if (chatId === undefined) return false;
    return allowedChatIds.includes(chatId);
};
