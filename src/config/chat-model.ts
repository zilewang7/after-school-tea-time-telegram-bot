/**
 * Which model a chat replies with: its own setting, else the global default
 * (panel value, else DEFAULT_MODEL). Synchronous: settings live in memory.
 */
import { getChatSettings, getGlobalDefaultModel } from '../services/chat-settings-cache.js';

export const resolveChatModel = (chatId: number): string =>
    getChatSettings(chatId)?.model ?? getGlobalDefaultModel();
