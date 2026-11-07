import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * The rendered width of an element, kept current with a ResizeObserver. The
 * charts draw in CSS pixels, so they need a real width rather than a viewBox.
 */
export const useElementWidth = (): [RefObject<HTMLDivElement | null>, number] => {
    const ref = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const element = ref.current;
        if (element === null) return;
        const update = (): void => setWidth(element.clientWidth);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return [ref, width];
};
