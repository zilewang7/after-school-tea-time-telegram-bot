import { useCallback, useMemo, useRef, useState } from 'react';
import type { AccessApplicationSummary, AccessApplicationsResponse, ApiFailure } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useApiQuery } from '../../../hooks/use-api-query';
import type { ApiQuery } from '../../../hooks/use-api-query';

/** 待审核 or every application */
export type AccessStatusFilter = 'pending' | 'all';

export interface AccessList {
    filter: AccessStatusFilter;
    setFilter: (filter: AccessStatusFilter) => void;
    query: ApiQuery<AccessApplicationsResponse>;
    loadingMore: boolean;
    loadMoreFailure: ApiFailure | null;
    loadMore: () => void;
}

/** A row that moved up between the two requests is not shown twice */
const appendAccessRows = (
    shown: readonly AccessApplicationSummary[],
    page: readonly AccessApplicationSummary[]
): AccessApplicationSummary[] => {
    const shownIds = new Set(shown.map((row) => row.id));
    return [...shown, ...page.filter((row) => !shownIds.has(row.id))];
};

/** One access application list: the first page follows the filter, further pages are appended */
export const useAccessList = (): AccessList => {
    const api = useApi();
    const [filter, setFilterState] = useState<AccessStatusFilter>('pending');
    // The filter an in-flight load-more belongs to; a filter change makes its answer stale
    const filterRef = useRef<AccessStatusFilter>(filter);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreFailure, setLoadMoreFailure] = useState<ApiFailure | null>(null);

    const load = useCallback(
        (signal: AbortSignal) => api.getAccessApplications({ status: filter }, signal),
        [api, filter]
    );
    const query = useApiQuery(load);
    const { reload, update } = query;

    const setFilter = useCallback(
        (next: AccessStatusFilter) => {
            if (next === filterRef.current) return;
            filterRef.current = next;
            setFilterState(next);
            setLoadingMore(false);
            setLoadMoreFailure(null);
            reload();
        },
        [reload]
    );

    const loadMore = useCallback(() => {
        if (query.state.status !== 'success') return;
        const offset = query.state.data.nextOffset;
        if (offset === null || loadingMore) return;
        const requestedFilter = filter;
        setLoadingMore(true);
        setLoadMoreFailure(null);
        void api.getAccessApplications({ status: requestedFilter, offset }).then((result) => {
            // The filter changed while the page was in flight: its rows belong to another list
            if (filterRef.current !== requestedFilter) return;
            setLoadingMore(false);
            if (!result.ok) {
                setLoadMoreFailure(result.failure);
                return;
            }
            update((data) => ({
                ...data,
                applications: appendAccessRows(data.applications, result.data.applications),
                matched: result.data.matched,
                nextOffset: result.data.nextOffset,
                stats: result.data.stats,
            }));
        });
    }, [api, filter, loadingMore, query.state, update]);

    return useMemo(
        () => ({ filter, setFilter, query, loadingMore, loadMoreFailure, loadMore }),
        [filter, setFilter, query, loadingMore, loadMoreFailure, loadMore]
    );
};
