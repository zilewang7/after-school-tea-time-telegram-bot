import { useCallback } from 'react';
import type { ChangeEvent } from 'react';

/** Telegram's single-message text limit (UTF-16 code units) */
export const TELEGRAM_MAX_LENGTH = 4096;

const PLACEHOLDER = '粘贴 Markdown：**粗体**、`行内代码`、> 引用、```代码块```、[链接](https://example.com)';

interface MarkdownEditorProps {
    value: string;
    onChange: (value: string) => void;
}

/** The markdown input: a monospace textarea with a length counter and the split hint */
export const MarkdownEditor = ({ value, onChange }: MarkdownEditorProps) => {
    const handleChange = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
        [onChange]
    );
    const parts = Math.ceil(value.length / TELEGRAM_MAX_LENGTH);
    return (
        <div className="field-group">
            <div className="field-label-row">
                <label className="field-label" htmlFor="tools-markdown-input">
                    Markdown
                </label>
                <span className={parts > 1 ? 'tools-over-limit' : 'hint'}>
                    {value.length}/{TELEGRAM_MAX_LENGTH}
                </span>
            </div>
            <textarea
                id="tools-markdown-input"
                className="field tools-textarea"
                value={value}
                rows={8}
                spellCheck={false}
                placeholder={PLACEHOLDER}
                onChange={handleChange}
            />
            {parts > 1 && (
                <p className="hint">
                    超过 {TELEGRAM_MAX_LENGTH} 字符，发送时客户端会自动拆成约 {parts} 条消息，不用手动分条；
                    拆分点处的格式会在每条消息里各自重新开始。
                </p>
            )}
        </div>
    );
};
