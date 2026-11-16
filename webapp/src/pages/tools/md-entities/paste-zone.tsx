import { useCallback } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';

interface PasteZoneProps {
    /** The box is controlled so typed text and paste results cannot drift apart */
    value: string;
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    /** null when the WebView cannot read the clipboard directly */
    onReadClipboard: (() => void) | null;
    reading: boolean;
}

/**
 * The paste target. A textarea (not a div) so mobile long-press paste works;
 * the paste handler reads the clipboard flavors and clears the field. Text
 * typed by hand goes through onChange and is treated as plain input.
 */
export const PasteZone = ({ value, onChange, onPaste, onReadClipboard, reading }: PasteZoneProps) => {
    const handleRead = useCallback(() => {
        if (onReadClipboard !== null) onReadClipboard();
    }, [onReadClipboard]);

    return (
        <div className="field-group">
            <textarea
                className="field tools-paste-zone"
                rows={4}
                placeholder="在 Telegram 里复制一条带格式的消息，然后点这里粘贴（Ctrl/⌘+V 或长按选择粘贴）"
                value={value}
                onChange={onChange}
                onPaste={onPaste}
            />
            {onReadClipboard !== null && (
                <button type="button" className="button secondary" disabled={reading} onClick={handleRead}>
                    {reading ? '读取中…' : '从剪贴板读取'}
                </button>
            )}
        </div>
    );
};
