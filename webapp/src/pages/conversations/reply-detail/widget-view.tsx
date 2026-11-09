import { useCallback, useMemo, useState } from 'react';
import { serverNowMs } from '../../../api';
import type { ReplyWidget } from '../../../api';
import { useWebApp } from '../../../context/panel-context';
import { useWidgetHeight, widgetFrameUrlOf } from './use-widget-height';

interface WidgetViewProps {
    widget: ReplyWidget;
    // A rendered PNG exists; only then the image fallback link works
    hasImage: boolean;
}

/**
 * The version's widget: the signed document in a sandboxed iframe, sized by its
 * own height reports. No allow-same-origin, so model-written JS cannot reach
 * the panel's origin (localStorage there throws, as documented).
 */
export const WidgetView = ({ widget, hasImage }: WidgetViewProps) => {
    const webApp = useWebApp();
    const { height, iframeRef } = useWidgetHeight();
    const [failed, setFailed] = useState(false);

    const frameUrl = useMemo(
        () => widgetFrameUrlOf(widget.viewUrl, webApp.colorScheme),
        [widget.viewUrl, webApp.colorScheme]
    );
    const modeLabel = useMemo(() => (widget.mode === 'a2ui' ? 'A2UI' : 'HTML'), [widget.mode]);
    // Signed URLs live ~10 minutes; a page left open that long must be reloaded rather than framed
    const expired = useMemo(() => {
        const expiresAtMs = Date.parse(widget.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs <= serverNowMs();
    }, [widget.expiresAt]);
    const handleError = useCallback(() => setFailed(true), []);

    const frameFailed = failed || expired;

    return (
        <div className="widget-card">
            <p className="badges">
                <span className="badge accent">卡片</span>
                <span className="badge">{modeLabel}</span>
                {widget.deliveredAs === 'link' && <span className="badge">群聊链接</span>}
            </p>
            {frameFailed ? (
                <div className="widget-fallback">
                    <p className="error-text">{expired ? '卡片链接已过期，刷新页面后再看' : '卡片加载失败'}</p>
                    {!expired && hasImage && (
                        <a className="button secondary" href={widget.imageUrl} target="_blank" rel="noreferrer">
                            查看渲染图
                        </a>
                    )}
                </div>
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
            {!frameFailed && hasImage && (
                <p className="hint">
                    <a href={widget.imageUrl} target="_blank" rel="noreferrer">
                        查看渲染图
                    </a>
                </p>
            )}
        </div>
    );
};

