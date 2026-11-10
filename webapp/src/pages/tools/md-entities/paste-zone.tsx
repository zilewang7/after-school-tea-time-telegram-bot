import { useCallback } from 'react';
import type { ClipboardEvent } from 'react';

interface PasteZoneProps {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    /** null when the WebView cannot read the clipboard directly */
    onReadClipboard: (() => void) | null;
    reading: boolean;
}

/**
 * The paste target. A textarea (not a div) so mobile long-press paste works;
 * the handler reads the flavors and clears the field, nothing is kept.
 */
export const PasteZone = ({ onPaste, onReadClipboard, reading }: PasteZoneProps) => {
    const handleRead = useCallback(() => {
        if (onReadClipboard !== null) onReadClipboard();
    }, [onReadClipboard]);

    return (
        <div className="field-group">
            <textarea
                className="field tools-paste-zone"
                rows={4}
                placeholder="在 Telegram 里复制一条带格式的消息，然后点这里粘贴（Ctrl/⌘+V 或长按选择粘贴）"
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
