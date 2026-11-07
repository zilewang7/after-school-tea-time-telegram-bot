import { useCallback, useEffect, useState } from 'react';
import type { ApiFailure, StatusResponse } from '../../api';
import { useApi } from '../../context/panel-context';
import { STATUS_POLL_MS } from '../../hooks/use-polling';

export interface StatusQuery {
    data: StatusResponse | null;
    // The last poll's failure; the last good answer stays on screen
    failure: ApiFailure | null;
    retry: () => void;
}

/** The live status, polled every 5s while the page is open (design §6.6) */
export const useStatus = (): StatusQuery => {
    const api = useApi();
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<{ data: StatusResponse | null; failure: ApiFailure | null }>({
        data: null,
        failure: null,
    });

    useEffect(() => {
        const controller = new AbortController();
        let timer: number | undefined;
        const poll = async (): Promise<void> => {
            const result = await api.getStatus(controller.signal);
            if (controller.signal.aborted) return;
            setState((previous) =>
                result.ok ? { data: result.data, failure: null } : { data: previous.data, failure: result.failure }
            );
            timer = window.setTimeout(() => {
                void poll();
            }, STATUS_POLL_MS);
        };
        void poll();
        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [api, attempt]);

    const retry = useCallback(() => setAttempt((count) => count + 1), []);
    return { data: state.data, failure: state.failure, retry };
};
