import { useCallback, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ADDENDUM_MAX_CODE_POINTS, estimateAddendumTokens } from '../../addendum';
import { useVerticalSwipeLock } from '../../hooks/use-telegram-guards';
import { AddendumPreviewView } from './addendum-preview-view';
import { useAddendumPreview } from './use-addendum-preview';

interface AddendumEditorProps {
    chatId: number;
    text: string;
    // Normalized value of `text` ('' when empty) and its length in code points
    normalizedValue: string;
    length: number;
    restoredFromDraft: boolean;
    disabled: boolean;
    onChange: (text: string) => void;
}

export const AddendumEditor = ({
    chatId,
    text,
    normalizedValue,
    length,
    restoredFromDraft,
    disabled,
    onChange,
}: AddendumEditorProps) => {
    const { state: previewState, requestPreview } = useAddendumPreview(chatId);
    const tooLong = length > ADDENDUM_MAX_CODE_POINTS;
    const [editing, setEditing] = useState(false);
    // Scrolling inside the text must not swipe the panel closed
    useVerticalSwipeLock(editing);

    const handleInput = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
        [onChange]
    );
    const handleFocus = useCallback(() => setEditing(true), []);
    const handleBlur = useCallback(() => setEditing(false), []);
    const handlePreview = useCallback(() => requestPreview(normalizedValue), [requestPreview, normalizedValue]);

    return (
        <div className="field-group">
            <div className="field-label-row">
                <label htmlFor="chat-addendum" className="field-label">
                    本聊天的附加提示词
                </label>
                <span className={tooLong ? 'error-text' : 'hint'}>
                    {length}/{ADDENDUM_MAX_CODE_POINTS} · 约 {estimateAddendumTokens(length)} token
                </span>
            </div>
            {restoredFromDraft && <p className="notice">已恢复未保存的草稿</p>}
            <textarea
                id="chat-addendum"
                className="field addendum-input"
                value={text}
                disabled={disabled}
                rows={5}
                placeholder="例如：群里讨论技术问题时直接给结论，再给理由。"
                onChange={handleInput}
                onFocus={handleFocus}
                onBlur={handleBlur}
            />
            {tooLong && <p className="error-text">超过 {ADDENDUM_MAX_CODE_POINTS} 字，无法保存</p>}
            <button
                type="button"
                className="button secondary"
                disabled={disabled || tooLong || previewState.kind === 'loading'}
                onClick={handlePreview}
            >
                预览运行时块
            </button>
            <AddendumPreviewView state={previewState} currentValue={normalizedValue} />
        </div>
    );
};
