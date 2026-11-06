import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWithRetry } from '../api';
import type { ApiFailure, ApiResult } from '../api';

export type QueryState<T> =
    | { status: 'loading' }
    | { status: 'success'; data: T }
    | { status: 'error'; failure: ApiFailure };

export interface ApiQuery<T> {
    state: QueryState<T>;
    // Shows the loading state again and re-fetches (retry button)
    reload: () => void;
    // Re-fetches in the background, keeping the current data on screen
    refresh: () => void;
    // Replaces the loaded data locally, e.g. with what a successful PATCH returned
    update: (updater: (data: T) => T) => void;
}

/**
 * Loads a GET endpoint, retrying every 5s while the bot is unreachable.
 * `load` must be stable (useCallback); a new identity triggers a new request.
 */
export const useApiQuery = <T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>): ApiQuery<T> => {
    const [state, setState] = useState<QueryState<T>>({ status: 'loading' });
    const [requestNumber, setRequestNumber] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        void getWithRetry(load, controller.signal).then((result) => {
            if (result === null) return;
            setState((previous): QueryState<T> => {
                if (result.ok) return { status: 'success', data: result.data };
                // A failed background refresh keeps the data already on screen
                if (previous.status === 'success') return previous;
                return { status: 'error', failure: result.failure };
            });
        });
        return () => controller.abort();
    }, [load, requestNumber]);

    const reload = useCallback(() => {
        setState({ status: 'loading' });
        setRequestNumber((count) => count + 1);
    }, []);

    const refresh = useCallback(() => {
        setRequestNumber((count) => count + 1);
    }, []);

    const update = useCallback((updater: (data: T) => T) => {
        setState((previous) =>
            previous.status === 'success' ? { status: 'success', data: updater(previous.data) } : previous
        );
    }, []);

    return useMemo(() => ({ state, reload, refresh, update }), [state, reload, refresh, update]);
};
