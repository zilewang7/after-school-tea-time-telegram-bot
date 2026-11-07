import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useLocation } from 'react-router';
import { getWithRetry } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { readConversationListSnapshot, writeConversationListSnapshot } from './conversation-list-snapshots';
import { conversationListReducer, initialConversationListState } from './conversation-list-state';
import type { ConversationListState } from './conversation-list-state';

export interface ConversationList {
    state: ConversationListState;
    loadMore: () => void;
    retry: () => void;
    // Background refresh of the newest page, keeping the rows on screen
    reload: () => void;
}

/**
 * One chat's conversation list with cursor pages. Its rows are kept per
 * history entry, so Back returns to them at once (no request) and the scroll
 * position comes back with them.
 */
export const useConversationList = (chatId: number): ConversationList => {
    const api = useApi();
    const { key: entryKey } = useLocation();
    const snapshotKey = `${entryKey}:${chatId}`;
    const [state, dispatch] = useReducer(conversationListReducer, snapshotKey, (key) =>
        initialConversationListState(readConversationListSnapshot(key))
    );

    // One fetch per request; a replaced request or leaving the page aborts it
    useEffect(() => {
        const request = state.request;
        if (request === null) return;
        const controller = new AbortController();
        void getWithRetry(
            (signal) => api.getConversations(chatId, request.before, signal),
            controller.signal
        ).then((result) => {
            if (result === null) return;
            if (result.ok) dispatch({ type: 'pageLoaded', request, response: result.data });
            else dispatch({ type: 'pageFailed', request, failure: result.failure });
        });
        return () => controller.abort();
    }, [api, chatId, state.request]);

    useEffect(() => {
        if (state.data !== null) writeConversationListSnapshot(snapshotKey, state.data);
    }, [snapshotKey, state.data]);

    const loadMore = useCallback(() => dispatch({ type: 'moreRequested' }), []);
    const retry = useCallback(() => dispatch({ type: 'retried' }), []);
    const reload = useCallback(() => dispatch({ type: 'reloaded' }), []);

    return useMemo(() => ({ state, loadMore, retry, reload }), [state, loadMore, retry, reload]);
};
