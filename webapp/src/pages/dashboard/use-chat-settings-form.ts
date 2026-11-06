import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ADDENDUM_MAX_CODE_POINTS,
    addendumValueOf,
    clearAddendumDraft,
    countCodePoints,
    restoreAddendumDraft,
    storeAddendumDraft,
} from '../../addendum';
import type { AddendumStart } from '../../addendum';
import { describeWriteFailure } from '../../api';
import type { ChatSettings, ChatSettingsPatch } from '../../api';
import type { SaveStatus } from '../../components/save-bar';
import { useApi } from '../../context/panel-context';
import { modelDraftOf, resolveModelDraft } from '../../model-draft';
import type { ModelDraft, ResolvedModel } from '../../model-draft';

const DRAFT_DEBOUNCE_MS = 500;

interface ChatSettingsFormOptions {
    chatId: number;
    // Server state this form instance started from; the form is re-created when it changes
    settings: ChatSettings;
    models: readonly string[];
    writable: boolean;
    onSaved: (settings: ChatSettings) => void;
}

interface DraftValues {
    model: ResolvedModel;
    addendumValue: string | null;
    paused: boolean;
    settingsLocked: boolean;
}

/** Only the keys that differ from the saved settings; an invalid model is left out */
const changedSettingsOf = (settings: ChatSettings, draft: DraftValues): ChatSettingsPatch => {
    const changes: ChatSettingsPatch = {};
    if (draft.model.ok && draft.model.value !== settings.model) changes.model = draft.model.value;
    if (draft.addendumValue !== settings.promptAddendum) changes.promptAddendum = draft.addendumValue;
    if (draft.paused !== settings.paused) changes.paused = draft.paused;
    if (draft.settingsLocked !== settings.settingsLocked) changes.settingsLocked = draft.settingsLocked;
    return changes;
};

export const useChatSettingsForm = ({ chatId, settings, models, writable, onSaved }: ChatSettingsFormOptions) => {
    const api = useApi();

    // Read-only users see the saved value; their stored draft (if any) is left for later
    const [addendumStart] = useState<AddendumStart>(() =>
        writable
            ? restoreAddendumDraft(chatId, settings.promptAddendum)
            : { text: settings.promptAddendum ?? '', restoredFromDraft: false }
    );
    const [modelDraft, setModelDraft] = useState<ModelDraft>(() => modelDraftOf(settings.model, models));
    const [addendumText, setAddendumText] = useState(addendumStart.text);
    const [paused, setPaused] = useState(settings.paused);
    const [settingsLocked, setSettingsLocked] = useState(settings.settingsLocked);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    // Debounced local draft of the addendum, so closing the panel does not lose typing
    useEffect(() => {
        if (!writable) return;
        const timer = window.setTimeout(
            () => storeAddendumDraft(chatId, addendumText, settings.promptAddendum),
            DRAFT_DEBOUNCE_MS
        );
        return () => window.clearTimeout(timer);
    }, [chatId, addendumText, settings.promptAddendum, writable]);

    const resolvedModel = useMemo(() => resolveModelDraft(modelDraft), [modelDraft]);
    const addendumValue = useMemo(() => addendumValueOf(addendumText), [addendumText]);
    const addendumLength = useMemo(() => countCodePoints(addendumValue ?? ''), [addendumValue]);

    const changes = useMemo(
        () => changedSettingsOf(settings, { model: resolvedModel, addendumValue, paused, settingsLocked }),
        [settings, resolvedModel, addendumValue, paused, settingsLocked]
    );

    const dirty = !resolvedModel.ok || Object.keys(changes).length > 0;
    const valid = resolvedModel.ok && addendumLength <= ADDENDUM_MAX_CODE_POINTS;
    const saving = saveStatus.kind === 'saving';

    const save = useCallback(() => {
        if (!writable || !dirty || !valid || saving) return;
        // Lets the server reject the save with 409 when someone else changed the settings meanwhile
        const patch: ChatSettingsPatch =
            settings.updatedAt === null ? changes : { ...changes, expectedUpdatedAt: settings.updatedAt };
        setSaveStatus({ kind: 'saving' });
        void api.patchChatSettings(chatId, patch).then((result) => {
            if (!result.ok) {
                // The local draft is kept on every failure, including 401
                setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                return;
            }
            clearAddendumDraft(chatId);
            setSaveStatus({ kind: 'idle' });
            onSaved(result.data.settings);
        });
    }, [writable, dirty, valid, saving, settings.updatedAt, changes, api, chatId, onSaved]);

    return {
        modelDraft,
        setModelDraft,
        modelError: resolvedModel.ok ? null : resolvedModel.error,
        addendumText,
        setAddendumText,
        addendumValue,
        addendumLength,
        restoredFromDraft: addendumStart.restoredFromDraft,
        paused,
        setPaused,
        settingsLocked,
        setSettingsLocked,
        dirty,
        valid,
        saveStatus,
        save,
    };
};
