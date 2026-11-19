import { useCallback, useMemo, useState } from 'react';
import { describeWriteFailure } from '../../api';
import type { PromptTemplateDetail, PromptTemplateVisibility } from '../../api';
import type { SaveStatus } from '../../components/save-bar';
import { useApi } from '../../context/panel-context';
import {
    promptTemplateCreateRequestOf,
    promptTemplateDraftChangedOf,
    promptTemplateDraftOf,
    promptTemplatePatchOf,
    validatePromptTemplateDraft,
} from './prompt-template-rules';
import type { PromptTemplateDraft } from './prompt-template-rules';

interface PromptTemplateFormOptions {
    // null = a new template
    template: PromptTemplateDetail | null;
    onSaved: () => void;
}

/** The 模板 form's state: typed values, validation and the create / PATCH write */
export const usePromptTemplateForm = ({ template, onSaved }: PromptTemplateFormOptions) => {
    const api = useApi();
    // The form is mounted once per template, so the start values do not need to follow the prop
    const [start] = useState<PromptTemplateDraft>(() => promptTemplateDraftOf(template));
    const [name, setName] = useState(start.name);
    const [content, setContent] = useState(start.content);
    const [patternsText, setPatternsText] = useState(start.patternsText);
    const [visibility, setVisibility] = useState<PromptTemplateVisibility>(start.visibility);
    const [enabled, setEnabled] = useState(start.enabled);
    const [sortOrderText, setSortOrderText] = useState(start.sortOrderText);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    const draft = useMemo<PromptTemplateDraft>(
        () => ({ name, content, patternsText, visibility, enabled, sortOrderText }),
        [name, content, patternsText, visibility, enabled, sortOrderText]
    );
    const validation = useMemo(() => validatePromptTemplateDraft(draft), [draft]);
    const dirty = useMemo(() => promptTemplateDraftChangedOf(template, draft), [template, draft]);
    const saving = saveStatus.kind === 'saving';

    const save = useCallback(() => {
        if (!dirty || !validation.valid || saving) return;
        const succeed = () => {
            setSaveStatus({ kind: 'idle' });
            onSaved();
        };
        setSaveStatus({ kind: 'saving' });
        if (template === null) {
            void api.createPromptTemplate(promptTemplateCreateRequestOf(draft, validation)).then((result) => {
                if (!result.ok) {
                    setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                    return;
                }
                succeed();
            });
            return;
        }
        const patch = promptTemplatePatchOf(template, draft, validation);
        // The values normalize back to the saved ones: nothing to write
        if (Object.keys(patch).length === 0) {
            succeed();
            return;
        }
        void api.patchPromptTemplate(template.id, patch).then((result) => {
            if (!result.ok) {
                setSaveStatus({ kind: 'failed', view: describeWriteFailure(result.failure) });
                return;
            }
            succeed();
        });
    }, [dirty, validation, saving, template, draft, api, onSaved]);

    return {
        name,
        setName,
        content,
        setContent,
        patternsText,
        setPatternsText,
        visibility,
        setVisibility,
        enabled,
        setEnabled,
        sortOrderText,
        setSortOrderText,
        validation,
        dirty,
        valid: validation.valid,
        saving,
        saveStatus,
        save,
    };
};
