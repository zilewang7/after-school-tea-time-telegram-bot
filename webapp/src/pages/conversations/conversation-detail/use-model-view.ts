import { useCallback, useMemo, useState } from 'react';
import type { ModelView } from '../../../api';
import type { ModelViewQuery } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useApiQuery } from '../../../hooks/use-api-query';
import type { ApiQuery } from '../../../hooks/use-api-query';
import { resolveModelDraft } from '../../../model-draft';
import type { ModelDraft } from '../../../model-draft';

export interface ModelViewState {
    // What is shown now; null fields mean the server's defaults
    query: ModelViewQuery;
    result: ApiQuery<ModelView>;
    draft: ModelDraft;
    setDraft: (draft: ModelDraft) => void;
    // Invalid draft text, if any
    error: string | null;
    // Recomputes with the draft model and the chosen user message
    apply: (at: number | null) => void;
}

/**
 * The model view of one conversation: a recomputation on demand, not a
 * snapshot of the original request. The draft model is applied explicitly, so
 * typing a model id does not fire a request per keystroke.
 */
export const useModelView = (chatId: number, rootId: number): ModelViewState => {
    const api = useApi();
    const [query, setQuery] = useState<ModelViewQuery>({ at: null, asModel: null });
    const [draft, setDraft] = useState<ModelDraft>({ kind: 'unset' });

    const load = useCallback(
        (signal: AbortSignal) => api.getModelView(chatId, rootId, query, signal),
        [api, chatId, rootId, query]
    );
    const result = useApiQuery(load);
    const resolved = useMemo(() => resolveModelDraft(draft), [draft]);

    const apply = useCallback(
        (at: number | null) => {
            if (!resolved.ok) return;
            setQuery({ at, asModel: resolved.value });
        },
        [resolved]
    );

    return {
        query,
        result,
        draft,
        setDraft,
        error: resolved.ok ? null : resolved.error,
        apply,
    };
};
