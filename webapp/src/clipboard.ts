/** Copy to the clipboard; false when the client refuses (no permission, old WebView) */
export const copyText = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
};

/** Which path actually put the content on the clipboard */
export type CopyChannel = 'clipboard-item' | 'copy-event' | 'plain-text' | 'failed';

export interface CopyRichResult {
    channel: CopyChannel;
    ok: boolean;
}

const HTML_TYPE = 'text/html';
const PLAIN_TYPE = 'text/plain';

/**
 * Rich copy, best effort in this order: async ClipboardItem (must start inside
 * the click gesture), a copy event through execCommand (WebView-friendly),
 * then plain text. The caller shows the channel that actually worked.
 */
export const copyRichText = async (html: string, plainText: string): Promise<CopyRichResult> => {
    if (await copyWithClipboardItem(html, plainText)) return { channel: 'clipboard-item', ok: true };
    if (copyWithCopyEvent(html, plainText)) return { channel: 'copy-event', ok: true };
    if (await copyText(plainText)) return { channel: 'plain-text', ok: true };
    return { channel: 'failed', ok: false };
};

/** Async Clipboard API path; HTML goes first so clients that pick one flavor prefer it */
const copyWithClipboardItem = async (html: string, plainText: string): Promise<boolean> => {
    if (typeof ClipboardItem === 'undefined') return false;
    if (typeof navigator.clipboard?.write !== 'function') return false;
    try {
        const item = new ClipboardItem({
            [HTML_TYPE]: new Blob([html], { type: HTML_TYPE }),
            [PLAIN_TYPE]: new Blob([plainText], { type: PLAIN_TYPE }),
        });
        await navigator.clipboard.write([item]);
        return true;
    } catch {
        return false;
    }
};

/** Copy event path: the only way some WebViews expose text/html */
const copyWithCopyEvent = (html: string, plainText: string): boolean => {
    let handled = false;
    const listener = (event: ClipboardEvent): void => {
        const data = event.clipboardData;
        if (data === null) return;
        data.setData(HTML_TYPE, html);
        data.setData(PLAIN_TYPE, plainText);
        event.preventDefault();
        handled = true;
    };
    document.addEventListener('copy', listener);
    try {
        const copied = document.execCommand('copy');
        return copied && handled;
    } catch {
        return false;
    } finally {
        document.removeEventListener('copy', listener);
    }
};
