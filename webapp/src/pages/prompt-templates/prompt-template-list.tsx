import { match } from 'ts-pattern';
import type { PromptTemplateListResponse, PromptTemplateSummary } from '../../api';
import { ErrorView, LoadingView } from '../../components/status-views';
import type { ApiQuery } from '../../hooks/use-api-query';
import { PromptTemplateRow } from './prompt-template-row';

interface PromptTemplateListProps {
    query: ApiQuery<PromptTemplateListResponse>;
    // The row whose switch or delete is being written
    pendingId: number | null;
    showCreator: boolean;
    onToggleEnabled: (template: PromptTemplateSummary, enabled: boolean) => void;
    onEdit: (templateId: number) => void;
    onDelete: (template: PromptTemplateSummary) => void;
}

/** The management list: the viewer's own templates, or every template for the owner */
export const PromptTemplateList = ({
    query,
    pendingId,
    showCreator,
    onToggleEnabled,
    onEdit,
    onDelete,
}: PromptTemplateListProps) =>
    match(query.state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={query.reload} />)
        .with({ status: 'success' }, ({ data }) =>
            data.templates.length === 0 ? (
                <p className="placeholder">还没有模板。新建一个，再到会话设置里启用。</p>
            ) : (
                <ul className="list">
                    {data.templates.map((template) => (
                        <PromptTemplateRow
                            key={template.id}
                            template={template}
                            pending={pendingId === template.id}
                            showCreator={showCreator}
                            onToggleEnabled={onToggleEnabled}
                            onEdit={onEdit}
                            onDelete={onDelete}
                        />
                    ))}
                </ul>
            )
        )
        .exhaustive();
