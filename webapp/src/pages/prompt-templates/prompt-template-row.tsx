import { useCallback, useMemo } from 'react';
import type { PromptTemplateSummary } from '../../api';
import { formatDateTime } from '../../format';
import {
    promptTemplateChatCountLabel,
    promptTemplatePatternsLabel,
    promptTemplateVisibilityLabel,
} from '../../prompt-templates';

interface PromptTemplateRowProps {
    template: PromptTemplateSummary;
    // A write for this row is in flight
    pending: boolean;
    // The owner sees every template, so each row names its creator
    showCreator: boolean;
    onToggleEnabled: (template: PromptTemplateSummary, enabled: boolean) => void;
    onEdit: (templateId: number) => void;
    onDelete: (template: PromptTemplateSummary) => void;
}

/** One template of the management list: switch, name, rule, visibility and actions */
export const PromptTemplateRow = ({
    template,
    pending,
    showCreator,
    onToggleEnabled,
    onEdit,
    onDelete,
}: PromptTemplateRowProps) => {
    const handleToggle = useCallback(
        () => onToggleEnabled(template, !template.enabled),
        [onToggleEnabled, template]
    );
    const handleEdit = useCallback(() => onEdit(template.id), [onEdit, template.id]);
    const handleDelete = useCallback(() => onDelete(template), [onDelete, template]);
    const updatedAt = useMemo(() => formatDateTime(template.updatedAt), [template.updatedAt]);

    return (
        <li>
            <div className="template-row">
                <label className="toggle-row">
                    <span className="toggle-text">
                        <span>{template.name}</span>
                        <span className="hint">{promptTemplatePatternsLabel(template.modelPatterns)}</span>
                    </span>
                    <input
                        type="checkbox"
                        role="switch"
                        className="switch"
                        checked={template.enabled}
                        disabled={pending}
                        onChange={handleToggle}
                    />
                </label>
                <p className="badges">
                    <span className="badge">{promptTemplateVisibilityLabel(template.visibility)}</span>
                    {showCreator && <span className="badge">创建者 {template.createdByName}</span>}
                    <span className="hint">{promptTemplateChatCountLabel(template.chatCount)}</span>
                    <span className="hint">
                        {template.contentLength} 字 · 更新于 {updatedAt}
                    </span>
                </p>
                <div className="button-row">
                    <button type="button" className="button secondary" disabled={pending} onClick={handleEdit}>
                        编辑
                    </button>
                    <button type="button" className="button secondary" disabled={pending} onClick={handleDelete}>
                        删除
                    </button>
                </div>
            </div>
        </li>
    );
};
