import { useParams } from 'react-router';

const CHAT_ID_PATTERN = /^-?\d{1,20}$/;

/** :chatId from the route, or null when it is not a usable chat id */
export const useChatIdParam = (): number | null => {
    const { chatId: rawChatId } = useParams();
    if (rawChatId === undefined || !CHAT_ID_PATTERN.test(rawChatId)) return null;
    const chatId = Number(rawChatId);
    return Number.isSafeInteger(chatId) ? chatId : null;
};
