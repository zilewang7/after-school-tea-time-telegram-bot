import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Scroll anyway when the widget never reports a height (e.g. its document failed to load) */
const FALLBACK_DELAY_MS = 1500;
/** Moving the page more than this before the scroll means the user scrolled first: keep their position */
const USER_SCROLL_TOLERANCE_PX = 8;

export interface ScrollTarget<T extends HTMLElement> {
    ref: RefObject<T | null>;
}

/**
 * Scrolls the element into view once, as soon as `ready` (an iframe's height
 * report, so the card is laid out) or after a fallback delay. A scroll the user
 * already made wins: this never fights the reader.
 */
export const useScrollIntoViewOnce = <T extends HTMLElement = HTMLDivElement>(
    enabled: boolean,
    ready: boolean
): ScrollTarget<T> => {
    const ref = useRef<T | null>(null);
    const done = useRef(false);
    const startScrollY = useRef<number | null>(null);

    useEffect(() => {
        if (!enabled) return;
        if (startScrollY.current === null) startScrollY.current = window.scrollY;
    }, [enabled]);

    const scroll = useCallback(() => {
        if (done.current) return;
        done.current = true;
        const element = ref.current;
        if (element === null) return;
        const initial = startScrollY.current;
        if (initial !== null && Math.abs(window.scrollY - initial) > USER_SCROLL_TOLERANCE_PX) return;
        element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, []);

    useEffect(() => {
        if (!enabled || done.current) return;
        if (ready) {
            scroll();
            return;
        }
        const timer = window.setTimeout(scroll, FALLBACK_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, ready, scroll]);

    return { ref };
};
