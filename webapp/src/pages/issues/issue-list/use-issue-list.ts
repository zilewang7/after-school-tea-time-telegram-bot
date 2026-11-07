import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useLocation } from 'react-router';
import { getWithRetry } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { DEFAULT_ISSUE_FILTERS, issueListQueryOf } from './issue-filters';
import type { IssueFilters } from './issue-filters';
import { readIssueListSnapshot, writeIssueListSnapshot } from './issue-list-snapshots';
import { initialIssueListState, issueListReducer } from './issue-list-state';
import type { IssueListState } from './issue-list-state';

export interface IssueList {
    state: IssueListState;
    setFilters: (filters: IssueFilters) => void;
    loadMore: () => void;
    retry: () => void;
}

/**
 * One issue list with filters and offset pages. Its rows are kept per history
 * entry, so when Back returns here they show at once (no request) and the
 * scroll position comes back with them.
 *
 * `scopeChatId` pins the list to a chat (a chat's tab); null lists every visible issue.
 */
export const useIssueList = (scopeChatId: number | null): IssueList => {
    const api = useApi();
    const { key: entryKey } = useLocation();
    const snapshotKey = `${entryKey}:${scopeChatId ?? 'home'}`;
    const [state, dispatch] = useReducer(issueListReducer, snapshotKey, (key) =>
        initialIssueListState(readIssueListSnapshot(key), DEFAULT_ISSUE_FILTERS)
    );

    // One fetch per request; a replaced request or leaving the page aborts it
    useEffect(() => {
        const request = state.request;
        if (request === null) return;
        const controller = new AbortController();
        void getWithRetry(
            (signal) => api.getIssues(issueListQueryOf(scopeChatId, request.filters, request.offset), signal),
            controller.signal
        ).then((result) => {
            if (result === null) return;
            if (result.ok) dispatch({ type: 'pageLoaded', request, response: result.data });
            else dispatch({ type: 'pageFailed', request, failure: result.failure });
        });
        return () => controller.abort();
    }, [api, scopeChatId, state.request]);

    useEffect(() => {
        if (state.data !== null) writeIssueListSnapshot(snapshotKey, state.data);
    }, [snapshotKey, state.data]);

    const setFilters = useCallback((filters: IssueFilters) => dispatch({ type: 'filtersChanged', filters }), []);
    const loadMore = useCallback(() => dispatch({ type: 'moreRequested' }), []);
    const retry = useCallback(() => dispatch({ type: 'retried' }), []);

    return useMemo(() => ({ state, setFilters, loadMore, retry }), [state, setFilters, loadMore, retry]);
};
