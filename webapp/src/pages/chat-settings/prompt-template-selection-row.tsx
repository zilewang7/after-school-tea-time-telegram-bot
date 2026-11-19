import { useCallback, useMemo, useState } from 'react';
import { match } from 'ts-pattern';
import type { ChatPromptTemplateSummary } from '../../api';
import { promptTemplateChatCountLabel, promptTemplateCreatorNameOf, promptTemplatePatternsLabel } from '../../prompt-templates';

type TemplateStatus = 'disabled' | 'manual' | 'auto' | 'none';

const STATUS_LABELS: Record<TemplateStatus, string> = {
    disabled: '已停用',
    manual: '已手动启用',
    auto: '自动加载中（当前模型匹配）',
    none: '未启用',
};

const statusBadgeClass = (status: TemplateStatus): string =>
    match(status)
        .with('manual', () => 'badge success')
        .with('auto', () => 'badge accent')
        .with('disabled', () => 'badge warning')
        .otherwise(() => 'badge');

const statusOf = (template: ChatPromptTemplateSummary, selected: boolean, auto: boolean): TemplateStatus => {
    if (!template.enabled) return 'disabled';
    if (selected) return 'manual';
    if (auto && template.autoMatchesViewerModel) return 'auto';
    return 'none';
};

interface PromptTemplateSelectionRowProps {
    template: ChatPromptTemplateSummary;
    // Manually enabled in the draft
    selected: boolean;
    // The draft's auto switch: the model-match hint only predicts an open switch
    auto: boolean;
    viewerId: number;
    // The form is read-only or saving
    disabled: boolean;
    onToggle: (templateId: number) => void;
}

/** One visible template in the chat settings: switch, rule, status and a folded content preview */
export const PromptTemplateSelectionRow = ({
    template,
    selected,
    auto,
    viewerId,
    disabled,
    onToggle,
}: PromptTemplateSelectionRowProps) => {
    const handleChange = useCallback(() => onToggle(template.id), [onToggle, template.id]);
    const creatorName = useMemo(() => promptTemplateCreatorNameOf(template, viewerId), [template, viewerId]);
    const status = useMemo(() => statusOf(template, selected, auto), [template, selected, auto]);
    // A disabled template cannot be enabled again here; an existing record may still be removed
    const toggleDisabled = disabled || (!template.enabled && !selected);
    const matchHint = !selected && template.enabled && template.autoMatchesViewerModel && !auto;
    // The content starts folded: a long list of templates would otherwise fill the whole page
    const [contentOpen, setContentOpen] = useState(false);
    const handleToggleContent = useCallback(() => setContentOpen((open) => !open), []);

    return (
        <li>
            <div className="template-row">
                <label className="toggle-row">
                    <span className="toggle-text">
                        <span>
                            {template.name}
                            {creatorName === null ? '' : `（${creatorName}）`}
                        </span>
                        <span className="hint">{promptTemplatePatternsLabel(template.modelPatterns)}</span>
                    </span>
                    <input
                        type="checkbox"
                        role="switch"
                        className="switch"
                        checked={selected}
                        disabled={toggleDisabled}
                        onChange={handleChange}
                    />
                </label>
                <p className="badges">
                    <span className={statusBadgeClass(status)}>{STATUS_LABELS[status]}</span>
                    {matchHint && <span className="hint">当前模型匹配，打开自动加载后生效</span>}
                    {!template.enabled && <span className="hint">模板已停用，所有会话都不加载</span>}
                    <span className="hint">{promptTemplateChatCountLabel(template.chatCount)}</span>
                </p>
                <button type="button" className="button secondary" onClick={handleToggleContent}>
                    {contentOpen ? '收起内容' : `查看内容（${template.contentLength} 字）`}
                </button>
                {contentOpen && <p className="prewrap">{template.contentPreview}</p>}
            </div>
        </li>
    );
};
