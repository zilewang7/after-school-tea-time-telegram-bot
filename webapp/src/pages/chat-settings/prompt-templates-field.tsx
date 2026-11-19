import { match } from 'ts-pattern';
import type { ChatPromptTemplateListResponse } from '../../api';
import { describeReadFailure } from '../../api';
import { CHAT_ADDENDUM_MAX_CODE_POINTS } from '../../addendum';
import { ToggleRow } from '../../components/toggle-row';
import type { ApiQuery } from '../../hooks/use-api-query';
import { PromptTemplateSelectionRow } from './prompt-template-selection-row';

interface PromptTemplatesFieldProps {
    // The templates this chat can see and enable; the server also sends their chat state
    templates: ApiQuery<ChatPromptTemplateListResponse>;
    // The draft: manually enabled ids and the auto switch
    selectedIds: readonly number[];
    auto: boolean;
    // Content lengths for the combined limit line (templates + custom text)
    templateContentLength: number;
    addendumLength: number;
    // The model the auto switch matches against, named in its description
    effectiveModel: string;
    viewerId: number;
    // The form is read-only or saving
    disabled: boolean;
    onAutoChange: (auto: boolean) => void;
    onToggleTemplate: (templateId: number) => void;
}

/** The chat settings' 提示词模板 section: the auto switch and the visible templates (design D10) */
export const PromptTemplatesField = ({
    templates,
    selectedIds,
    auto,
    templateContentLength,
    addendumLength,
    effectiveModel,
    viewerId,
    disabled,
    onAutoChange,
    onToggleTemplate,
}: PromptTemplatesFieldProps) => {
    const composedLength = templateContentLength + addendumLength;
    const overLimit = composedLength > CHAT_ADDENDUM_MAX_CODE_POINTS;

    return (
        <div className="field-group">
            <span className="field-label">提示词模板</span>
            <ToggleRow
                label="按模型匹配自动加载"
                description={`打开后，本会话自动加载当前模型（${effectiveModel}）匹配的可见模板；手动启用的模板不受影响`}
                checked={auto}
                disabled={disabled}
                onChange={onAutoChange}
            />
            {match(templates.state)
                .with({ status: 'loading' }, () => <p className="hint">正在加载可见模板…</p>)
                .with({ status: 'error' }, ({ failure }) => (
                    <div className="save-failure">
                        <p className="error-text">{describeReadFailure(failure)}</p>
                        <button type="button" className="button secondary" onClick={templates.reload}>
                            重试
                        </button>
                    </div>
                ))
                .with({ status: 'success' }, ({ data }) =>
                    data.templates.length === 0 ? (
                        <p className="hint">还没有对你可见的模板</p>
                    ) : (
                        <ul className="list">
                            {data.templates.map((template) => (
                                <PromptTemplateSelectionRow
                                    key={template.id}
                                    template={template}
                                    selected={selectedIds.includes(template.id)}
                                    auto={auto}
                                    viewerId={viewerId}
                                    disabled={disabled}
                                    onToggle={onToggleTemplate}
                                />
                            ))}
                        </ul>
                    )
                )
                .exhaustive()}
            <p className={overLimit ? 'error-text' : 'hint'}>
                {`手动启用 ${templateContentLength} 字 + 自定义 ${addendumLength} 字 = ${composedLength}/${CHAT_ADDENDUM_MAX_CODE_POINTS}`}
            </p>
            {overLimit && <p className="error-text">合计超过 {CHAT_ADDENDUM_MAX_CODE_POINTS} 字，无法保存</p>}
        </div>
    );
};
