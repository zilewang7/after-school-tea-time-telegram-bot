import { useCallback, useMemo, useState } from 'react';
import { describeWriteFailure } from '../../api';
import type { GlobalSettingsResponse } from '../../api';
import type { SaveStatus } from '../../components/save-bar';
import { useApi } from '../../context/panel-context';
import { modelDraftOf, resolveModelDraft } from '../../model-draft';
import type { ModelDraft } from '../../model-draft';

interface GlobalSettingsFormOptions {
    // Server state this form instance started from; the form is re-created when it changes
    global: GlobalSettingsResponse;
    models: readonly string[];
    onSaved: (global: GlobalSettingsResponse) => void;
}

export const useGlobalSettingsForm = ({ global, models, onSaved }: GlobalSettingsFormOptions) => {
    const api = useApi();
    const [modelDraft, setModelDraft] = useState<ModelDraft>(() => modelDraftOf(global.defaultModel, models));
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    const resolvedModel = useMemo(() => resolveModelDraft(modelDraft), [modelDraft]);
    // null (back to env) is only offered while the panel overrides env, where it always differs
    const dirty = !resolvedModel.ok || resolvedModel.value !== global.defaultModel;
    const valid = resolvedModel.ok;
    const saving = saveStatus.kind === 'saving';

    const save = useCallback(() => {
        if (!resolvedModel.ok || !dirty || saving) return;
        setSaveStatus({ kind: 'saving' });
        void api.patchGlobal(resolvedModel.value).then((result) => {
            if (!result.ok) {
                setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                return;
            }
            setSaveStatus({ kind: 'idle' });
            onSaved(result.data);
        });
    }, [resolvedModel, dirty, saving, api, onSaved]);

    return {
        modelDraft,
        setModelDraft,
        modelError: resolvedModel.ok ? null : resolvedModel.error,
        dirty,
        valid,
        saveStatus,
        save,
    };
};
