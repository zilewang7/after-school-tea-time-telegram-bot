import { useCallback, useRef, useState } from 'react';
import { describeReadFailure } from '../../api';
import type { AddendumPreviewResponse } from '../../api';
import { useApi } from '../../context/panel-context';

export type PreviewState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    // previewedValue is the normalized addendum the block was rendered for
    | { kind: 'ready'; previewedValue: string; result: AddendumPreviewResponse }
    | { kind: 'failed'; message: string };

/** Server-rendered runtime block for an addendum; only the latest request's answer is kept */
export const useAddendumPreview = (chatId: number) => {
    const api = useApi();
    const [state, setState] = useState<PreviewState>({ kind: 'idle' });
    const latestRequestNumber = useRef(0);

    const requestPreview = useCallback(
        (addendumValue: string) => {
            const requestNumber = latestRequestNumber.current + 1;
            latestRequestNumber.current = requestNumber;
            setState({ kind: 'loading' });
            void api.previewAddendum(chatId, addendumValue).then((result) => {
                if (latestRequestNumber.current !== requestNumber) return;
                setState(
                    result.ok
                        ? { kind: 'ready', previewedValue: addendumValue, result: result.data }
                        : { kind: 'failed', message: describeReadFailure(result.failure) }
                );
            });
        },
        [api, chatId]
    );

    return { state, requestPreview };
};
