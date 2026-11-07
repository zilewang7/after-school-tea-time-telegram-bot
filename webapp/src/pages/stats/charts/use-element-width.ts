import { useCallback, useEffect, useState } from 'react';
import type { RefCallback } from 'react';

/**
 * The rendered width of an element, kept current with a ResizeObserver. The
 * charts draw in CSS pixels, so they need a real width rather than a viewBox.
 *
 * The element is tracked as state rather than through a RefObject: a chart card
 * unmounts its chart while it shows the table, and the remounted element must
 * be observed again (a detached one reports width 0, which made the chart
 * disappear after a table round trip).
 */
export const useElementWidth = (): [RefCallback<HTMLDivElement>, number] => {
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    const ref = useCallback((node: HTMLDivElement | null) => setElement(node), []);

    useEffect(() => {
        if (element === null) return;
        const update = (): void => {
            // The element leaves the document while the table is shown; that 0 is not the chart's width
            if (!element.isConnected) return;
            setWidth(element.clientWidth);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);

    return [ref, width];
};
