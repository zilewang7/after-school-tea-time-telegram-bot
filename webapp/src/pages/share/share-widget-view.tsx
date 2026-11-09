import { useCallback, useMemo, useState } from 'react';
import { useWebApp } from '../../context/panel-context';
import { useScrollIntoViewOnce } from '../../hooks/use-scroll-into-view';
import { useWidgetHeight, widgetFrameUrlOf } from '../../hooks/use-widget-height';
import { shareWidgetUrlOf } from '../../share/share-asset-urls';

interface ShareWidgetViewProps {
    token: string;
    // Position among the page's widgets, numbered like the SSR page
    index: number;
    caption: string | null;
    // Scroll the card into view once, so a link lands on the card itself
    autoFocus?: boolean;
}

/**
 * A shared widget: the same sandboxed iframe the panel uses, sized by the
 * document's own height reports. No allow-same-origin, so model-written JS
 * cannot reach this page's origin.
 */
export const ShareWidgetView = ({ token, index, caption, autoFocus = false }: ShareWidgetViewProps) => {
    const webApp = useWebApp();
    const { height, reported, iframeRef } = useWidgetHeight();
    const { ref: cardRef } = useScrollIntoViewOnce(autoFocus, reported);
    const [failed, setFailed] = useState(false);

    const frameUrl = useMemo(
        () => widgetFrameUrlOf(shareWidgetUrlOf(token, index), webApp.colorScheme),
        [token, index, webApp.colorScheme]
    );
    const handleError = useCallback(() => setFailed(true), []);

    return (
        <div className="widget-card" ref={cardRef}>
            {failed ? (
                <p className="error-text">卡片加载失败</p>
            ) : (
                <iframe
                    ref={iframeRef}
                    className="widget-frame"
                    title="回复卡片"
                    src={frameUrl}
                    sandbox="allow-scripts"
                    loading="lazy"
                    height={height}
                    onError={handleError}
                />
            )}
            {caption !== null && caption !== '' && <p className="hint prewrap">{caption}</p>}
        </div>
    );
};
