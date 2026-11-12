import type { GlobalSettingsPatch, GlobalSettingsResponse } from '../../api';
import type { ResolvedModel } from '../../model-draft';

/** The global settings form's values, ready to compare with the saved settings */
export interface GlobalSettingsDraft {
    model: ResolvedModel;
    geminiPriority: boolean;
}

/** Only the keys that differ from the saved settings; an invalid model is left out */
export const changedGlobalSettingsOf = (
    global: GlobalSettingsResponse,
    draft: GlobalSettingsDraft
): GlobalSettingsPatch => {
    const changes: GlobalSettingsPatch = {};
    // null (back to env) is only offered while the panel overrides env, where it always differs
    if (draft.model.ok && draft.model.value !== global.defaultModel) changes.defaultModel = draft.model.value;
    if (draft.geminiPriority !== global.defaultGeminiPriority) {
        changes.defaultGeminiPriority = draft.geminiPriority;
    }
    return changes;
};
