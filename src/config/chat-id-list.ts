/**
 * Comma-separated chat id lists from the env (ALLOWED_CHAT_IDS, TOOL_CHAT_IDS).
 */

/** The integer ids in `raw`, in order; blanks, junk and 0 are dropped */
export const parseChatIdList = (raw: string | undefined): number[] =>
    (raw ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(Number)
        .filter((chatId) => Number.isSafeInteger(chatId) && chatId !== 0);
