import { useCallback, useRef, useState } from 'react';
import { describeReadFailure } from '../../api';
import type { AddendumPreviewRequest, AddendumPreviewResponse } from '../../api';
import { useApi } from '../../context/panel-context';

/** The form values a preview was rendered for, so the view can flag a stale preview */
export interface AddendumPreviewDraft {
    // The normalized custom text ('' when empty)
    addendumValue: string;
    // Manually enabled template ids
    templateIds: readonly number[];
    templatesAuto: boolean;
}

export type PreviewState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; previewedDraft: AddendumPreviewDraft; result: AddendumPreviewResponse }
    | { kind: 'failed'; message: string };

const canonicalIdsOf = (ids: readonly number[]): number[] =>
    Array.from(new Set(ids)).sort((left, right) => left - right);

/** Whether two drafts would preview the same block (ids compared canonically) */
export const sameAddendumPreviewDraft = (left: AddendumPreviewDraft, right: AddendumPreviewDraft): boolean => {
    const leftIds = canonicalIdsOf(left.templateIds);
    const rightIds = canonicalIdsOf(right.templateIds);
    return (
        left.addendumValue === right.addendumValue &&
        left.templatesAuto === right.templatesAuto &&
        leftIds.length === rightIds.length &&
        leftIds.every((id, index) => id === rightIds[index])
    );
};

/** Server-rendered runtime block for the addendum draft (custom text + templates); only the latest answer is kept */
export const useAddendumPreview = (chatId: number) => {
    const api = useApi();
    const [state, setState] = useState<PreviewState>({ kind: 'idle' });
    const latestRequestNumber = useRef(0);

    const requestPreview = useCallback(
        (draft: AddendumPreviewDraft) => {
            const requestNumber = latestRequestNumber.current + 1;
            latestRequestNumber.current = requestNumber;
            setState({ kind: 'loading' });
            // null means "no templates" (the preview must not fall back to the saved list)
            const body: AddendumPreviewRequest = {
                promptAddendum: draft.addendumValue,
                promptTemplateIds: draft.templateIds.length === 0 ? null : canonicalIdsOf(draft.templateIds),
                promptTemplatesAuto: draft.templatesAuto,
            };
            void api.previewAddendum(chatId, body).then((result) => {
                if (latestRequestNumber.current !== requestNumber) return;
                setState(
                    result.ok
                        ? { kind: 'ready', previewedDraft: draft, result: result.data }
                        : { kind: 'failed', message: describeReadFailure(result.failure) }
                );
            });
        },
        [api, chatId]
    );

    return { state, requestPreview };
};
