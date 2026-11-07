import { useCallback, useState } from 'react';
import { describeExclusionFailure } from '../../../api';
import type { WriteFailureView } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';

export interface Exclusion {
    setExcluded: (messageId: number, excluded: boolean) => void;
    // The node whose request is in flight
    pendingMessageId: number | null;
    failure: WriteFailureView | null;
    clearFailure: () => void;
}

/** Excluding / restoring one message, then refreshing the tree (the #N of the rest shift) */
export const useExclusion = (chatId: number, onChanged: () => void): Exclusion => {
    const api = useApi();
    const notifySuccess = useSuccessHaptic();
    const [pendingMessageId, setPendingMessageId] = useState<number | null>(null);
    const [failure, setFailure] = useState<WriteFailureView | null>(null);

    const setExcluded = useCallback(
        (messageId: number, excluded: boolean) => {
            if (pendingMessageId !== null) return;
            setPendingMessageId(messageId);
            setFailure(null);
            void api.setExclusion(chatId, messageId, excluded).then((result) => {
                setPendingMessageId(null);
                if (!result.ok) {
                    setFailure(describeExclusionFailure(result.failure));
                    return;
                }
                notifySuccess();
                onChanged();
            });
        },
        [api, chatId, onChanged, notifySuccess, pendingMessageId]
    );

    const clearFailure = useCallback(() => setFailure(null), []);

    return { setExcluded, pendingMessageId, failure, clearFailure };
};
