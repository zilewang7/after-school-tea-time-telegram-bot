import { useEffect, useMemo, useState } from 'react';
import { markdownToRendered, renderedToPreviewHtml } from '../../../tools/entity-convert';
import type { RenderedMarkdown } from '../../../tools/types';

/** Live-preview debounce: renderMarkdown costs ~11ms per 4 KB, typing must not wait for it */
const PREVIEW_DEBOUNCE_MS = 250;

const useDebouncedValue = <TValue,>(value: TValue, delayMs: number): TValue => {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);
    return debounced;
};

export type ForwardPreview =
    | { kind: 'empty' }
    | { kind: 'failed' }
    | { kind: 'ready'; rendered: RenderedMarkdown; previewHtml: string };

/**
 * Markdown -> entities + preview HTML, debounced so the editor stays
 * responsive on long input. Copy actions convert the current value directly.
 */
export const useForwardPreview = (markdown: string): ForwardPreview => {
    const debounced = useDebouncedValue(markdown, PREVIEW_DEBOUNCE_MS);
    return useMemo<ForwardPreview>(() => {
        if (debounced.trim() === '') return { kind: 'empty' };
        try {
            const rendered = markdownToRendered(debounced);
            return { kind: 'ready', rendered, previewHtml: renderedToPreviewHtml(rendered) };
        } catch {
            return { kind: 'failed' };
        }
    }, [debounced]);
};
