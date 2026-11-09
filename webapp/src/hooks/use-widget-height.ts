// The wrapper document inside the widget iframe reports its own height; the panel follows it.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

export const DEFAULT_WIDGET_HEIGHT = 600;
export const MAX_WIDGET_HEIGHT = 1600;
/** A card may be short, but a collapsed frame should still show something */
const MIN_WIDGET_HEIGHT = 120;

const HEIGHT_MESSAGE_TYPE = 'k-on-bot:widget-height';

/** The signed view URL with the panel's theme, so the wrapper paints matching --tg-theme-* colors */
export const widgetFrameUrlOf = (viewUrl: string, colorScheme: 'light' | 'dark'): string => {
    const separator = viewUrl.includes('?') ? '&' : '?';
    return `${viewUrl}${separator}theme=${colorScheme}`;
};

const clampWidgetHeight = (height: number): number =>
    Math.min(MAX_WIDGET_HEIGHT, Math.max(MIN_WIDGET_HEIGHT, Math.ceil(height)));

interface HeightMessage {
    type: typeof HEIGHT_MESSAGE_TYPE;
    height: number;
}

const isHeightMessage = (data: unknown): data is HeightMessage => {
    if (typeof data !== 'object' || data === null) return false;
    if (!('type' in data) || data.type !== HEIGHT_MESSAGE_TYPE) return false;
    return 'height' in data && typeof data.height === 'number' && Number.isFinite(data.height);
};

export interface WidgetFrame {
    // CSS pixels; starts at the default until the wrapper reports its own height
    height: number;
    iframeRef: RefObject<HTMLIFrameElement | null>;
}

/**
 * Follows the card's height, reported by the wrapper document from inside the
 * sandboxed iframe. Only messages from that frame count, so another window
 * cannot resize the card.
 */
export const useWidgetHeight = (): WidgetFrame => {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [height, setHeight] = useState(DEFAULT_WIDGET_HEIGHT);

    useEffect(() => {
        const handleMessage = (event: MessageEvent<unknown>) => {
            const frame = iframeRef.current;
            if (frame === null || event.source !== frame.contentWindow) return;
            if (!isHeightMessage(event.data)) return;
            setHeight(clampWidgetHeight(event.data.height));
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    return useMemo(() => ({ height, iframeRef }), [height]);
};
