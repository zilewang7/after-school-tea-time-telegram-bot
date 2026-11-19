import { useCallback } from 'react';
import type { ChatPromptTemplateListResponse } from '../../api';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import type { ApiQuery } from '../../hooks/use-api-query';

/**
 * The templates this chat may enable (prompt-template design D4). The server sends
 * `enabledInChat` and `autoMatchesViewerModel`, so the panel mirrors no visibility
 * or glob rule; reloading follows the chat id.
 */
export const useChatPromptTemplates = (chatId: number): ApiQuery<ChatPromptTemplateListResponse> => {
    const api = useApi();
    const load = useCallback((signal: AbortSignal) => api.getChatPromptTemplates(chatId, signal), [api, chatId]);
    return useApiQuery(load);
};
