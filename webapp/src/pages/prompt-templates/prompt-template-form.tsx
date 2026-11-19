import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';
import { countCodePoints } from '../../addendum';
import type { PromptTemplateDetail, PromptTemplateVisibility } from '../../api';
import { ChoiceChips } from '../../components/choice-chips';
import type { ChoiceOption } from '../../components/choice-chips';
import { LengthCounter } from '../../components/length-counter';
import { SaveBar } from '../../components/save-bar';
import { ToggleRow } from '../../components/toggle-row';
import { useVerticalSwipeLock } from '../../hooks/use-telegram-guards';
import {
    PROMPT_TEMPLATE_CONTENT_MAX,
    PROMPT_TEMPLATE_NAME_MAX,
    PROMPT_TEMPLATE_SORT_ORDER_MAX,
} from '../../prompt-templates';
import { usePromptTemplateForm } from './use-prompt-template-form';

const VISIBILITY_OPTIONS: readonly ChoiceOption<PromptTemplateVisibility>[] = [
    { value: 'global', label: '全局可见' },
    { value: 'group', label: '同群群聊用户可见' },
    { value: 'private', label: '完全隐藏' },
];

const SORT_ORDER_HINT = `组合顺序：数值小的先加载（0–${PROMPT_TEMPLATE_SORT_ORDER_MAX}）`;

interface PromptTemplateFormProps {
    // null = a new template
    template: PromptTemplateDetail | null;
    onSaved: () => void;
    onCancel: () => void;
}

/** The create / edit form of one template; the page mounts at most one at a time */
export const PromptTemplateForm = ({ template, onSaved, onCancel }: PromptTemplateFormProps) => {
    const form = usePromptTemplateForm({ template, onSaved });
    const disabled = form.saving;
    const [editing, setEditing] = useState(false);
    // Scrolling inside a textarea must not swipe the panel closed
    useVerticalSwipeLock(editing);

    const { setName, setContent, setPatternsText, setSortOrderText } = form;
    const handleNameInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        [setName]
    );
    const handleContentInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setContent(event.target.value),
        [setContent]
    );
    const handlePatternsInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setPatternsText(event.target.value),
        [setPatternsText]
    );
    const handleSortOrderInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => setSortOrderText(event.target.value),
        [setSortOrderText]
    );
    const handleFocus = useCallback(() => setEditing(true), []);
    const handleBlur = useCallback(() => setEditing(false), []);

    const { validation } = form;

    return (
        <>
            <h2 className="section-title">{template === null ? '新建模板' : `编辑：${template.name}`}</h2>

            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="prompt-template-name" className="field-label">
                        名字
                    </label>
                    <LengthCounter length={countCodePoints(form.name)} max={PROMPT_TEMPLATE_NAME_MAX} />
                </div>
                <input
                    id="prompt-template-name"
                    className="field"
                    type="text"
                    value={form.name}
                    disabled={disabled}
                    placeholder="例如：hydrogen 引导"
                    onChange={handleNameInput}
                />
                {validation.nameError !== null && <p className="error-text">{validation.nameError}</p>}
            </div>

            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="prompt-template-content" className="field-label">
                        内容
                    </label>
                    <LengthCounter length={countCodePoints(form.content)} max={PROMPT_TEMPLATE_CONTENT_MAX} />
                </div>
                <textarea
                    id="prompt-template-content"
                    className="field addendum-input"
                    value={form.content}
                    disabled={disabled}
                    rows={8}
                    placeholder="模板会作为附加提示词注入每条回复的运行时块末尾。"
                    onChange={handleContentInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                />
                {validation.contentError !== null && <p className="error-text">{validation.contentError}</p>}
            </div>

            <div className="field-group">
                <label htmlFor="prompt-template-patterns" className="field-label">
                    加载规则
                </label>
                <textarea
                    id="prompt-template-patterns"
                    className="field"
                    value={form.patternsText}
                    disabled={disabled}
                    rows={3}
                    placeholder={'deepseek*\ngemini-4-hydrogen'}
                    onChange={handlePatternsInput}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                />
                <p className="hint">一行一个模型匹配式，只支持 * 通配；留空 = 不参与自动加载（仍可手动启用）。</p>
                {validation.patternsError !== null && <p className="error-text">{validation.patternsError}</p>}
            </div>

            <div className="field-group">
                <span className="field-label">可见性</span>
                <ChoiceChips
                    label="可见性"
                    options={VISIBILITY_OPTIONS}
                    selected={form.visibility}
                    disabled={disabled}
                    onSelect={form.setVisibility}
                />
                <p className="hint">
                    默认「全局可见」，所有面板用户都能看到并启用；「同群群聊用户可见」只对与创建者同群的面板用户可见；「完全隐藏」只有自己可见，且只能在私聊里启用。
                </p>
            </div>

            <ToggleRow
                label="模板启用"
                description="停用后任何会话都不加载，会话里的启用记录保留"
                checked={form.enabled}
                disabled={disabled}
                onChange={form.setEnabled}
            />

            <div className="field-group">
                <label htmlFor="prompt-template-sort-order" className="field-label">
                    排序
                </label>
                <input
                    id="prompt-template-sort-order"
                    className="field"
                    type="number"
                    min={0}
                    max={PROMPT_TEMPLATE_SORT_ORDER_MAX}
                    value={form.sortOrderText}
                    disabled={disabled}
                    onChange={handleSortOrderInput}
                />
                <p className="hint">{SORT_ORDER_HINT}</p>
                {validation.sortOrderError !== null && <p className="error-text">{validation.sortOrderError}</p>}
            </div>

            <SaveBar
                writable
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={false}
                savedMessage=""
                pendingHint={null}
                onSave={form.save}
                onRefresh={null}
            />

            <div className="button-row">
                <button type="button" className="button secondary" disabled={form.saving} onClick={onCancel}>
                    取消
                </button>
            </div>
        </>
    );
};
