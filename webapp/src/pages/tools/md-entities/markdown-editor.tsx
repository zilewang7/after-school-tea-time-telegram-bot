import { useCallback } from 'react';
import type { ChangeEvent } from 'react';

/** Telegram's single-message text limit (UTF-16 code units); the preview uses it */
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
    return (
        <div className="field-group">
            <div className="field-label-row">
                <label className="field-label" htmlFor="tools-markdown-input">
                    Markdown
                </label>
                <span className="hint">{value.length} 字符</span>
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
        </div>
    );
};
