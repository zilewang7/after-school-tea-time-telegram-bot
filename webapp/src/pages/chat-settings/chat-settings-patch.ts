import type { ChatSettings, ChatSettingsPatch } from '../../api';
import type { ResolvedModel } from '../../model-draft';

/** The chat settings form's values, ready to compare with the saved settings */
export interface ChatSettingsDraft {
    model: ResolvedModel;
    addendumValue: string | null;
    paused: boolean;
    settingsLocked: boolean;
    geminiPriority: boolean | null;
    // null = model default, 'off' = thinking off, else a graded effort
    thinkingEffort: string | null;
}

/** Only the keys that differ from the saved settings; an invalid model is left out */
export const changedSettingsOf = (settings: ChatSettings, draft: ChatSettingsDraft): ChatSettingsPatch => {
    const changes: ChatSettingsPatch = {};
    if (draft.model.ok && draft.model.value !== settings.model) changes.model = draft.model.value;
    if (draft.addendumValue !== settings.promptAddendum) changes.promptAddendum = draft.addendumValue;
    if (draft.paused !== settings.paused) changes.paused = draft.paused;
    if (draft.settingsLocked !== settings.settingsLocked) changes.settingsLocked = draft.settingsLocked;
    // Owner only: members cannot move the choice, so it never enters their patches
    if (draft.geminiPriority !== settings.geminiPriority) changes.geminiPriority = draft.geminiPriority;
    // An explicit null goes out too: it is how the chat goes back to the model default
    if (draft.thinkingEffort !== settings.thinkingEffort) changes.thinkingEffort = draft.thinkingEffort;
    return changes;
};
