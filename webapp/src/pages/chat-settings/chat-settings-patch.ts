import type { ChatSettings, ChatSettingsPatch } from '../../api';
import type { ResolvedModel } from '../../model-draft';

/** The chat settings form's values, ready to compare with the saved settings */
export interface ChatSettingsDraft {
    model: ResolvedModel;
    addendumValue: string | null;
    // Manually enabled prompt templates, ascending; null = none
    templateIds: number[] | null;
    // Load the visible templates whose rule matches the reply's model
    templatesAuto: boolean;
    paused: boolean;
    settingsLocked: boolean;
    geminiPriority: boolean | null;
    // null = model default, 'off' = thinking off, else a graded effort
    thinkingEffort: string | null;
    richReplies: boolean;
}

/** Ascending, deduplicated ids, whatever order the form collected them in */
const canonicalTemplateIdsOf = (ids: readonly number[]): number[] =>
    Array.from(new Set(ids)).sort((left, right) => left - right);

/** The value to PATCH: canonical ids, or null when none is enabled (the server stores NULL) */
export const templateIdsValueOf = (ids: readonly number[]): number[] | null => {
    const canonical = canonicalTemplateIdsOf(ids);
    return canonical.length === 0 ? null : canonical;
};

// null and the empty array both mean "none enabled"
const sameTemplateIds = (draftIds: readonly number[] | null, savedIds: readonly number[] | null): boolean => {
    const draft = draftIds === null ? [] : canonicalTemplateIdsOf(draftIds);
    const saved = savedIds === null ? [] : canonicalTemplateIdsOf(savedIds);
    return draft.length === saved.length && draft.every((id, index) => id === saved[index]);
};

/** Only the keys that differ from the saved settings; an invalid model is left out */
export const changedSettingsOf = (settings: ChatSettings, draft: ChatSettingsDraft): ChatSettingsPatch => {
    const changes: ChatSettingsPatch = {};
    if (draft.model.ok && draft.model.value !== settings.model) changes.model = draft.model.value;
    if (draft.addendumValue !== settings.promptAddendum) changes.promptAddendum = draft.addendumValue;
    if (!sameTemplateIds(draft.templateIds, settings.promptTemplateIds)) {
        changes.promptTemplateIds = templateIdsValueOf(draft.templateIds ?? []);
    }
    if (draft.templatesAuto !== settings.promptTemplatesAuto) changes.promptTemplatesAuto = draft.templatesAuto;
    if (draft.paused !== settings.paused) changes.paused = draft.paused;
    if (draft.settingsLocked !== settings.settingsLocked) changes.settingsLocked = draft.settingsLocked;
    // Owner only: members cannot move the choice, so it never enters their patches
    if (draft.geminiPriority !== settings.geminiPriority) changes.geminiPriority = draft.geminiPriority;
    // An explicit null goes out too: it is how the chat goes back to the model default
    if (draft.thinkingEffort !== settings.thinkingEffort) changes.thinkingEffort = draft.thinkingEffort;
    if (draft.richReplies !== settings.richReplies) changes.richReplies = draft.richReplies;
    return changes;
};
