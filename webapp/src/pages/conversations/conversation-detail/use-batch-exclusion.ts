/**
 * One batch exclusion write from the multi-select view (design 2026-1119-2016
 * §4.6): the request in flight, its failure, and the server's per-id answer.
 * The selection stays on screen on failure so the user can retry; on success
 * the parent exits the mode and re-reads the tree (every #N can shift).
 */
import { useCallback, useState } from 'react';
import { describeExclusionFailure } from '../../../api';
import type { ExclusionBatchAction, ExclusionBatchResponse, WriteFailureView } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';

export interface BatchExclusion {
    /** The action whose request is in flight; null when idle */
    pending: ExclusionBatchAction | null;
    failure: WriteFailureView | null;
    /** The server's answer to the last successful write; null before one */
    result: ExclusionBatchResponse | null;
    /** Sends one batch write; true when the server took it (missing ids included) */
    submit: (action: ExclusionBatchAction, messageIds: readonly number[]) => Promise<boolean>;
    /** Drops the last result and failure, for a new selection round */
    reset: () => void;
    clearFailure: () => void;
}

export const useBatchExclusion = (chatId: number, onChanged: () => void): BatchExclusion => {
    const api = useApi();
    const notifySuccess = useSuccessHaptic();
    const [pending, setPending] = useState<ExclusionBatchAction | null>(null);
    const [failure, setFailure] = useState<WriteFailureView | null>(null);
    const [result, setResult] = useState<ExclusionBatchResponse | null>(null);

    const submit = useCallback(
        (action: ExclusionBatchAction, messageIds: readonly number[]): Promise<boolean> => {
            if (pending !== null) return Promise.resolve(false);
            setPending(action);
            setFailure(null);
            setResult(null);
            return api.batchExclusion(chatId, action, messageIds).then((response) => {
                setPending(null);
                if (!response.ok) {
                    setFailure(describeExclusionFailure(response.failure));
                    return false;
                }
                setResult(response.data);
                notifySuccess();
                onChanged();
                return true;
            });
        },
        [api, chatId, onChanged, notifySuccess, pending]
    );

    const reset = useCallback(() => {
        setFailure(null);
        setResult(null);
    }, []);

    const clearFailure = useCallback(() => setFailure(null), []);

    return { pending, failure, result, submit, reset, clearFailure };
};
