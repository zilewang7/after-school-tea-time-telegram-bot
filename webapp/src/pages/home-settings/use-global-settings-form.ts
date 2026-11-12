import { useCallback, useMemo, useState } from 'react';
import { describeWriteFailure } from '../../api';
import type { GlobalSettingsResponse } from '../../api';
import type { SaveStatus } from '../../components/save-bar';
import { useApi } from '../../context/panel-context';
import { modelDraftOf, resolveModelDraft } from '../../model-draft';
import type { ModelDraft } from '../../model-draft';
import { changedGlobalSettingsOf } from './global-settings-patch';

interface GlobalSettingsFormOptions {
    // Server state this form instance started from; the form is re-created when it changes
    global: GlobalSettingsResponse;
    models: readonly string[];
    onSaved: (global: GlobalSettingsResponse) => void;
}

export const useGlobalSettingsForm = ({ global, models, onSaved }: GlobalSettingsFormOptions) => {
    const api = useApi();
    const [modelDraft, setModelDraft] = useState<ModelDraft>(() => modelDraftOf(global.defaultModel, models));
    const [geminiPriority, setGeminiPriority] = useState(global.defaultGeminiPriority);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    const resolvedModel = useMemo(() => resolveModelDraft(modelDraft), [modelDraft]);
    const changes = useMemo(
        () => changedGlobalSettingsOf(global, { model: resolvedModel, geminiPriority }),
        [global, resolvedModel, geminiPriority]
    );
    const dirty = !resolvedModel.ok || Object.keys(changes).length > 0;
    const valid = resolvedModel.ok;
    const saving = saveStatus.kind === 'saving';

    // One PATCH of every changed key: the server writes them all or none
    const save = useCallback(() => {
        if (!valid || !dirty || saving) return;
        setSaveStatus({ kind: 'saving' });
        void api.patchGlobal(changes).then((result) => {
            if (!result.ok) {
                setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                return;
            }
            setSaveStatus({ kind: 'idle' });
            onSaved(result.data);
        });
    }, [valid, dirty, saving, api, changes, onSaved]);

    return {
        modelDraft,
        setModelDraft,
        modelError: resolvedModel.ok ? null : resolvedModel.error,
        geminiPriority,
        setGeminiPriority,
        dirty,
        valid,
        saving,
        saveStatus,
        save,
    };
};
