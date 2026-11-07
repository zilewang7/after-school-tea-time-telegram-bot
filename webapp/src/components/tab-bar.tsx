import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { useNavigate } from 'react-router';

export interface TabBarItem {
    id: string;
    label: string;
    // Absolute path of the tab
    to: string;
    badge: ComponentType | null;
}

// Room kept between the active tab and the scroller's edge
const EDGE_MARGIN_PX = 16;

/** Scrolls the tab strip sideways just enough to show the target tab */
const revealHorizontally = (scroller: HTMLElement, target: HTMLElement): void => {
    const left = target.offsetLeft - EDGE_MARGIN_PX;
    const right = target.offsetLeft + target.offsetWidth + EDGE_MARGIN_PX;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
};

interface TabButtonProps {
    item: TabBarItem;
    active: boolean;
    onSelect: (item: TabBarItem) => void;
}

const TabButton = ({ item, active, onSelect }: TabButtonProps) => {
    const handleClick = useCallback(() => onSelect(item), [onSelect, item]);
    const Badge = item.badge;
    return (
        <button type="button" role="tab" aria-selected={active} className="tab" onClick={handleClick}>
            {item.label}
            {Badge !== null && <Badge />}
        </button>
    );
};

interface TabBarProps {
    items: readonly TabBarItem[];
    // null on a page of the layer that is not a tab (e.g. the redirect at /c/:chatId)
    activeId: string | null;
}

/** Sticky row of text tabs in the style of Telegram's chat folders; scrolls sideways when it overflows */
export const TabBar = ({ items, activeId }: TabBarProps) => {
    const navigate = useNavigate();
    const scrollerRef = useRef<HTMLDivElement>(null);

    const handleSelect = useCallback(
        (item: TabBarItem) => {
            // Re-tapping the current tab scrolls back to the top, as in Telegram
            if (item.id === activeId) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
            // Tab switches replace the history entry, so Back leaves the layer instead of walking through tabs
            void navigate(item.to, { replace: true });
        },
        [activeId, navigate]
    );

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (scroller === null) return;
        const activeButton = scroller.querySelector('[aria-selected="true"]');
        if (activeButton instanceof HTMLElement) revealHorizontally(scroller, activeButton);
    }, [activeId]);

    return (
        <nav className="tab-bar">
            <div className="tab-scroller" role="tablist" ref={scrollerRef}>
                {items.map((item) => (
                    <TabButton key={item.id} item={item} active={item.id === activeId} onSelect={handleSelect} />
                ))}
            </div>
        </nav>
    );
};
