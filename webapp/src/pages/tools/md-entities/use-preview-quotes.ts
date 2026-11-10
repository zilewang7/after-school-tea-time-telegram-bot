/**
 * Collapsible quotes in the preview, the way the Telegram clients draw them:
 * the quote keeps three lines, and only a quote that is taller than that gets
 * the chevron in its bottom-right corner (a shorter quote collapses to nothing,
 * so the clients show no chevron at all).
 *
 * The preview HTML is static, so the clip, the chevron button and the state are
 * applied here, after the HTML lands in the DOM. The content is wrapped in a
 * div because a max-height on the quote itself would clip at the padding box
 * and let a groove of the fourth line show.
 */
import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/** Lines a collapsed quote keeps, matching the Telegram clients */
const COLLAPSED_LINES = 3;

/** Line-height fallback when the preview CSS does not set one (1.3125 × 16px) */
const FALLBACK_LINE_HEIGHT_EM = 1.3125;

/** Names of the injected nodes and state classes */
const CLIP_CLASS = 'tools-quote-clip';
const MORE_BUTTON_CLASS = 'tools-quote-more';

/** 1px tolerance for the integer scrollHeight / clientHeight rounding */
const OVERFLOW_EPSILON = 1;

interface QuoteLabels {
    expand: string;
    collapse: string;
}

const lengthOf = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Height of the content box that shows exactly COLLAPSED_LINES lines */
const collapsedHeightOf = (element: HTMLElement): number => {
    const style = window.getComputedStyle(element);
    const lineHeight = lengthOf(style.lineHeight) || lengthOf(style.fontSize) * FALLBACK_LINE_HEIGHT_EM;
    return COLLAPSED_LINES * lineHeight;
};

/** The div that clips the quote content; created once per rendered quote */
const clipOf = (quote: HTMLElement): HTMLElement => {
    const existing = quote.querySelector<HTMLElement>(`:scope > .${CLIP_CLASS}`);
    if (existing !== null) return existing;
    const clip = document.createElement('div');
    clip.className = CLIP_CLASS;
    while (quote.firstChild !== null) clip.append(quote.firstChild);
    quote.append(clip);
    return clip;
};

const setExpanded = (
    quote: HTMLElement,
    clip: HTMLElement,
    button: HTMLButtonElement,
    expanded: boolean,
    labels: QuoteLabels
): void => {
    quote.classList.toggle('is-collapsed', !expanded);
    quote.classList.toggle('is-expanded', expanded);
    clip.style.maxHeight = expanded ? '' : `${collapsedHeightOf(quote)}px`;
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? labels.collapse : labels.expand);
};

const createMoreButton = (
    quote: HTMLElement,
    clip: HTMLElement,
    labels: QuoteLabels
): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = MORE_BUTTON_CLASS;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', labels.expand);
    button.addEventListener('click', () =>
        setExpanded(quote, clip, button, !quote.classList.contains('is-expanded'), labels)
    );
    return button;
};

/**
 * Clip first and ask the browser whether the clip actually hides anything: a
 * quote of three lines or fewer keeps its full height and gets no chevron.
 */
const decorateQuote = (quote: HTMLElement, labels: QuoteLabels): void => {
    const wasExpanded = quote.classList.contains('is-expanded');
    quote.classList.remove('is-collapsed', 'is-expanded', 'is-short');
    quote.querySelector(`.${MORE_BUTTON_CLASS}`)?.remove();
    const clip = clipOf(quote);

    clip.style.maxHeight = `${collapsedHeightOf(quote)}px`;
    quote.classList.add('is-collapsed');
    if (clip.scrollHeight <= clip.clientHeight + OVERFLOW_EPSILON) {
        quote.classList.remove('is-collapsed');
        quote.classList.add('is-short');
        clip.style.maxHeight = '';
        return;
    }

    const button = createMoreButton(quote, clip, labels);
    quote.append(button);
    if (wasExpanded) setExpanded(quote, clip, button, true, labels);
};

/**
 * Decorate the expandable quotes of the preview bubble. Re-runs on every new
 * preview and whenever the bubble changes width, because the three-line clip
 * depends on where the text wraps.
 */
export const usePreviewQuotes = (
    container: RefObject<HTMLDivElement | null>,
    html: string,
    expandLabel: string,
    collapseLabel: string
): void => {
    useLayoutEffect(() => {
        const root = container.current;
        if (root === null) return;
        const labels: QuoteLabels = { expand: expandLabel, collapse: collapseLabel };
        const decorateAll = (): void => {
            for (const quote of root.querySelectorAll<HTMLElement>('blockquote.tg-expandable')) {
                decorateQuote(quote, labels);
            }
        };
        decorateAll();

        // Height changes are our own clip; only a width change needs a re-measure
        // (tab switch from a hidden panel, window resize, font reflow on mobile)
        let lastWidth = root.clientWidth;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? 0;
            if (width === lastWidth) return;
            lastWidth = width;
            decorateAll();
        });
        observer.observe(root);
        return () => observer.disconnect();
    }, [container, html, expandLabel, collapseLabel]);
};
