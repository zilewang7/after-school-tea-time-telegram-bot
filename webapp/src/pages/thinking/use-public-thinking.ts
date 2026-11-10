import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWithRetry } from '../../api';
import type { ApiFailure, PublicThinkingResponse, PublicThinkingStatus } from '../../api';
import { useApi } from '../../context/panel-context';

/** How often a generating CoT is polled for its new tail */
export const THINKING_POLL_MS = 700;
/** Quiet retry delay for a failed poll; the page keeps whatever it already shows */
export const THINKING_RETRY_MS = 1500;
/** Failed polls tolerated before the page gives up and offers a manual retry */
const MAX_SILENT_FAILURES = 3;

/** One thinking link as the page sees it: the whole CoT plus its metadata */
export interface PublicThinking {
    token: string;
    model: string | null;
    createdAt: string;
    status: PublicThinkingStatus;
    errorMessage: string | null;
    text: string;
    // The offset to poll from next
    next: number;
}

export type ThinkingQueryState =
    | { status: 'loading' }
    | { status: 'ready'; thinking: PublicThinking }
    | { status: 'error'; failure: ApiFailure };

export interface ThinkingQuery {
    state: ThinkingQueryState;
    // Shows the loading state again and starts over (retry button)
    reload: () => void;
}

/**
 * The page text after one response: a reset snapshot, a full snapshot that
 * extends what we have, the appended delta, or nothing new.
 */
export const applyThinkingText = (text: string, response: PublicThinkingResponse): string => {
    if (response.reset === true) return response.text;
    const full = response.text;
    // The server may send the whole CoT even with `after`: a longer text starting with ours is a snapshot
    if (full.length > text.length && full.startsWith(text)) return full;
    if (response.delta !== undefined) return `${text}${response.delta}`;
    return full === '' ? text : full;
};

/** 401/403/404/410 are final: retrying cannot make the token exist */
const isTerminalFailure = (failure: ApiFailure): boolean =>
    failure.kind === 'http' &&
    (failure.status === 401 || failure.status === 403 || failure.status === 404 || failure.status === 410);

const thinkingOf = (response: PublicThinkingResponse, text: string): PublicThinking => ({
    token: response.token,
    model: response.model,
    createdAt: response.createdAt,
    status: response.status,
    errorMessage: response.errorMessage,
    text,
    next: response.next,
});

/** Whether the CoT can still grow: `done` or `unavailable` ends the polling */
const canStillGrow = (response: PublicThinkingResponse): boolean =>
    !response.done && response.status !== 'unavailable';

/**
 * GET /api/public/thinking/:token: the first load takes the whole CoT, then
 * the page polls `after=next` for the tail every 700ms until it is done.
 * The token is the only permission, so no initData is involved.
 */
export const usePublicThinking = (token: string): ThinkingQuery => {
    const api = useApi();
    const [state, setState] = useState<ThinkingQueryState>({ status: 'loading' });
    const [requestNumber, setRequestNumber] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let timer: number | null = null;
        let failures = 0;
        let loaded = false;
        let text = '';
        let after: number | null = null;

        const stopTimer = (): void => {
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
        };

        const schedule = (delayMs: number): void => {
            stopTimer();
            timer = window.setTimeout(() => {
                void poll();
            }, delayMs);
        };

        const accept = (response: PublicThinkingResponse): void => {
            loaded = true;
            failures = 0;
            text = applyThinkingText(after === null ? '' : text, response);
            after = response.next;
            setState({ status: 'ready', thinking: thinkingOf(response, text) });
            if (canStillGrow(response)) schedule(THINKING_POLL_MS);
        };

        const reject = (failure: ApiFailure): void => {
            if (isTerminalFailure(failure)) {
                setState({ status: 'error', failure });
                return;
            }
            failures += 1;
            // With no content yet the page stays on its loading state for a few quiet retries
            if (!loaded && failures >= MAX_SILENT_FAILURES) {
                setState({ status: 'error', failure });
                return;
            }
            schedule(THINKING_RETRY_MS);
        };

        async function poll(): Promise<void> {
            const result = await api.getPublicThinking(token, after, controller.signal);
            if (cancelled) return;
            if (result.ok) accept(result.data);
            else reject(result.failure);
        }

        // The first load retries an unreachable bot with the panel's banner
        void (async () => {
            const first = await getWithRetry(
                (signal) => api.getPublicThinking(token, null, signal),
                controller.signal
            );
            if (cancelled || first === null) return;
            if (first.ok) accept(first.data);
            else setState({ status: 'error', failure: first.failure });
        })();

        return () => {
            cancelled = true;
            stopTimer();
            controller.abort();
        };
    }, [api, token, requestNumber]);

    const reload = useCallback(() => {
        setState({ status: 'loading' });
        setRequestNumber((count) => count + 1);
    }, []);

    return useMemo(() => ({ state, reload }), [state, reload]);
};
