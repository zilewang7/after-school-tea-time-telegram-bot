import type { ChatSettingKey, ChatSettings, ChatSettingsPatch } from '../../api';
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

/** Every per-chat setting except toolOverrides (managed in its own tab) is diffed here */
type FormChatSettingKey = Exclude<ChatSettingKey, 'toolOverrides'>;

const FORM_SETTING_DIFFERS: Readonly<
    Record<FormChatSettingKey, (settings: ChatSettings, draft: ChatSettingsDraft) => boolean>
> = {
    model: (settings, draft) => draft.model.ok && draft.model.value !== settings.model,
    promptAddendum: (settings, draft) => draft.addendumValue !== settings.promptAddendum,
    promptTemplateIds: (settings, draft) => !sameTemplateIds(draft.templateIds, settings.promptTemplateIds),
    promptTemplatesAuto: (settings, draft) => draft.templatesAuto !== settings.promptTemplatesAuto,
    paused: (settings, draft) => draft.paused !== settings.paused,
    settingsLocked: (settings, draft) => draft.settingsLocked !== settings.settingsLocked,
    // Owner only: members cannot move the choice, so it never enters their patches
    geminiPriority: (settings, draft) => draft.geminiPriority !== settings.geminiPriority,
    // An explicit null goes out too: it is how the chat goes back to the model default
    thinkingEffort: (settings, draft) => draft.thinkingEffort !== settings.thinkingEffort,
    richReplies: (settings, draft) => draft.richReplies !== settings.richReplies,
};

/** Only the keys that differ from the saved settings; an invalid model is left out */
export const changedSettingsOf = (settings: ChatSettings, draft: ChatSettingsDraft): ChatSettingsPatch => {
    const changes: ChatSettingsPatch = {};
    if (FORM_SETTING_DIFFERS.model(settings, draft) && draft.model.ok) changes.model = draft.model.value;
    if (FORM_SETTING_DIFFERS.promptAddendum(settings, draft)) changes.promptAddendum = draft.addendumValue;
    if (FORM_SETTING_DIFFERS.promptTemplateIds(settings, draft)) {
        changes.promptTemplateIds = templateIdsValueOf(draft.templateIds ?? []);
    }
    if (FORM_SETTING_DIFFERS.promptTemplatesAuto(settings, draft)) changes.promptTemplatesAuto = draft.templatesAuto;
    if (FORM_SETTING_DIFFERS.paused(settings, draft)) changes.paused = draft.paused;
    if (FORM_SETTING_DIFFERS.settingsLocked(settings, draft)) changes.settingsLocked = draft.settingsLocked;
    if (FORM_SETTING_DIFFERS.geminiPriority(settings, draft)) changes.geminiPriority = draft.geminiPriority;
    if (FORM_SETTING_DIFFERS.thinkingEffort(settings, draft)) changes.thinkingEffort = draft.thinkingEffort;
    if (FORM_SETTING_DIFFERS.richReplies(settings, draft)) changes.richReplies = draft.richReplies;
    return changes;
};
