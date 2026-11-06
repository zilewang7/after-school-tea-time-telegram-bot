import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUDIT_PAGE_SIZE, describeReadFailure, getWithRetry } from '../../api';
import type { AuditEntry } from '../../api';
import { useApi } from '../../context/panel-context';

type LoadMoreState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; message: string };

/** Appends older audit pages (beforeId = oldest loaded id) after the first page */
export const useAuditPagination = (chatId: number | null, firstPage: readonly AuditEntry[]) => {
    const api = useApi();
    const [olderPages, setOlderPages] = useState<AuditEntry[][]>([]);
    const [loadMoreState, setLoadMoreState] = useState<LoadMoreState>({ kind: 'idle' });
    const abortControllerRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortControllerRef.current?.abort(), []);

    const entries = useMemo(() => [...firstPage, ...olderPages.flat()], [firstPage, olderPages]);
    const lastPageLength = olderPages.at(-1)?.length ?? firstPage.length;
    // A short page means the server had nothing older
    const hasMore = lastPageLength >= AUDIT_PAGE_SIZE;
    const oldestId = entries.at(-1)?.id ?? null;
    const loading = loadMoreState.kind === 'loading';

    const loadMore = useCallback(() => {
        if (oldestId === null || loading) return;
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setLoadMoreState({ kind: 'loading' });
        void getWithRetry((signal) => api.getAudit({ chatId, beforeId: oldestId }, signal), controller.signal).then(
            (result) => {
                if (result === null) return;
                if (result.ok) {
                    setOlderPages((pages) => [...pages, result.data.entries]);
                    setLoadMoreState({ kind: 'idle' });
                } else {
                    setLoadMoreState({ kind: 'failed', message: describeReadFailure(result.failure) });
                }
            }
        );
    }, [oldestId, loading, api, chatId]);

    return { entries, hasMore, loadMoreState, loadMore };
};
