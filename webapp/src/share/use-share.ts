import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeShareFailure } from '../api';
import type { ShareLink } from '../api';
import { useApi } from '../context/panel-context';
import { useApiQuery } from '../hooks/use-api-query';
import { shareCreateRequestOf, shareQueryOf } from './share-link';
import type { ShareTarget } from './share-link';

export interface ShareController {
    // The target's active link; null when it has none
    share: ShareLink | null;
    // The active link is being looked up: the bar shows nothing rather than a wrong state
    loading: boolean;
    // A create or revoke request is in flight
    busy: boolean;
    // Wording of the last failed action; null once an action succeeds
    error: string | null;
    // Creates (or reuses) the target's link; null when the request failed
    create: () => Promise<ShareLink | null>;
    revoke: () => Promise<void>;
}

/** The share link of one target: load the active link, create it (idempotent) and revoke it */
export const useShare = (target: ShareTarget): ShareController => {
    const api = useApi();
    const loadShare = useCallback(
        (signal: AbortSignal) => api.getShare(shareQueryOf(target), signal),
        [api, target]
    );
    const lookup = useApiQuery(loadShare);
    const [share, setShare] = useState<ShareLink | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const lookupState = lookup.state;
    useEffect(() => {
        // A failed lookup keeps "no link yet": creating is idempotent, so it cannot duplicate one
        if (lookupState.status === 'success') setShare(lookupState.data.share);
    }, [lookupState]);

    const create = useCallback(async (): Promise<ShareLink | null> => {
        if (busy) return null;
        setBusy(true);
        setError(null);
        const result = await api.createShare(shareCreateRequestOf(target));
        setBusy(false);
        if (!result.ok) {
            setError(describeShareFailure(result.failure).message);
            return null;
        }
        setShare(result.data.share);
        return result.data.share;
    }, [api, target, busy]);

    const revoke = useCallback(async (): Promise<void> => {
        if (busy || share === null) return;
        setBusy(true);
        setError(null);
        const result = await api.revokeShare(share.token);
        setBusy(false);
        if (!result.ok) {
            // A token that is already gone (revoked elsewhere) counts as revoked
            if (result.failure.kind === 'http' && result.failure.status === 404) {
                setShare(null);
                return;
            }
            setError(describeShareFailure(result.failure).message);
            return;
        }
        setShare(null);
    }, [api, share, busy]);

    return useMemo(
        () => ({ share, loading: lookupState.status === 'loading', busy, error, create, revoke }),
        [share, lookupState, busy, error, create, revoke]
    );
};
