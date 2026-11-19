import { useCallback } from 'react';
import { match } from 'ts-pattern';
import { ErrorView, LoadingView } from '../../components/status-views';
import { useApi } from '../../context/panel-context';
import { useApiQuery } from '../../hooks/use-api-query';
import { PromptTemplateForm } from './prompt-template-form';

interface PromptTemplateEditorProps {
    // null = a new template's form
    templateId: number | null;
    onSaved: () => void;
    onCancel: () => void;
}

interface PromptTemplateLoaderProps {
    templateId: number;
    onSaved: () => void;
    onCancel: () => void;
}

/** An existing template's full content is not in the list, so the editor loads it first */
const PromptTemplateDetailLoader = ({ templateId, onSaved, onCancel }: PromptTemplateLoaderProps) => {
    const api = useApi();
    const load = useCallback(
        (signal: AbortSignal) => api.getPromptTemplate(templateId, signal),
        [api, templateId]
    );
    const query = useApiQuery(load);

    return match(query.state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={query.reload} />)
        .with({ status: 'success' }, ({ data }) => (
            <PromptTemplateForm template={data.template} onSaved={onSaved} onCancel={onCancel} />
        ))
        .exhaustive();
};

/** The page's single open editor: the new-template form, or one template loaded for editing */
export const PromptTemplateEditor = ({ templateId, onSaved, onCancel }: PromptTemplateEditorProps) =>
    templateId === null ? (
        <PromptTemplateForm template={null} onSaved={onSaved} onCancel={onCancel} />
    ) : (
        <PromptTemplateDetailLoader templateId={templateId} onSaved={onSaved} onCancel={onCancel} />
    );
