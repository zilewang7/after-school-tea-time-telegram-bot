import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { getWithRetry } from '../../api';
import type { StatsRangeKey } from '../../api';
import { useApi } from '../../context/panel-context';
import { DEFAULT_STATS_RANGE } from './stats-range';
import { initialStatsState, statsReducer } from './stats-state';
import type { StatsState } from './stats-state';

export interface StatsQuery {
    state: StatsState;
    setRange: (range: StatsRangeKey) => void;
    retry: () => void;
    // A new range is loading over the rows already on screen
    refreshing: boolean;
}

/** Statistics of one chat (or every chat, for the owner): loads on demand per range, keeping the old charts */
export const useStats = (chatId: number | null, initialRange: StatsRangeKey = DEFAULT_STATS_RANGE): StatsQuery => {
    const api = useApi();
    const [state, dispatch] = useReducer(statsReducer, { chatId, range: initialRange }, (initial) =>
        initialStatsState(initial.chatId, initial.range)
    );

    useEffect(() => {
        const request = state.request;
        if (request === null) return;
        const controller = new AbortController();
        void getWithRetry(
            (signal) => api.getStats(request.chatId, request.range, signal),
            controller.signal
        ).then((result) => {
            if (result === null) return;
            if (result.ok) dispatch({ type: 'loaded', request, response: result.data });
            else dispatch({ type: 'failed', request, failure: result.failure });
        });
        return () => controller.abort();
    }, [api, state.request]);

    const setRange = useCallback((range: StatsRangeKey) => dispatch({ type: 'rangeChanged', range }), []);
    const retry = useCallback(() => dispatch({ type: 'retried' }), []);
    const refreshing = state.request !== null && state.data !== null;

    return useMemo(() => ({ state, setRange, retry, refreshing }), [state, setRange, retry, refreshing]);
};
