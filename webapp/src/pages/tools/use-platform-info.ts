import { useMemo } from 'react';
import { useWebApp } from '../../context/panel-context';
import { resolveClientPlatform } from '../../tools/platform-channel';
import type { ClientPlatform } from '../../tools/types';

export interface PlatformInfo {
    platform: ClientPlatform;
    /** The WebView can put text/html on the clipboard (async ClipboardItem + write) */
    htmlSupported: boolean;
    /** Paste events carry the clipboard flavors (the direction-2 input path) */
    pasteSupported: boolean;
    /** navigator.clipboard.read() exists; the host may still refuse it */
    clipboardReadSupported: boolean;
}

const hasHtmlClipboard = (): boolean => {
    if (typeof ClipboardItem === 'undefined') return false;
    if (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('text/html')) return false;
    return typeof navigator.clipboard?.write === 'function';
};

const hasPasteEvent = (): boolean => 'onpaste' in window;

const hasClipboardRead = (): boolean => typeof navigator.clipboard?.read === 'function';

/** Platform and clipboard capabilities of the current WebView, probed once per mount */
export const usePlatformInfo = (): PlatformInfo => {
    const webApp = useWebApp();
    return useMemo<PlatformInfo>(
        () => ({
            platform: resolveClientPlatform(webApp.platform),
            htmlSupported: hasHtmlClipboard(),
            pasteSupported: hasPasteEvent(),
            clipboardReadSupported: hasClipboardRead(),
        }),
        [webApp.platform]
    );
};
