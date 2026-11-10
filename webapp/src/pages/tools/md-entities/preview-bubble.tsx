import { useRef } from 'react';
import { usePreviewQuotes } from './use-preview-quotes';

interface PreviewBubbleProps {
    /** Complete HTML fragment from renderedToPreviewHtml; styles are included */
    html: string;
}

/**
 * The Telegram-style preview bubble. The HTML is generated locally from the
 * markdown the user typed (the library escapes every text run), never raw
 * user-supplied HTML.
 */
export const PreviewBubble = ({ html }: PreviewBubbleProps) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    usePreviewQuotes(containerRef, html, '展开引用', '收起引用');
    return <div className="tools-preview" ref={containerRef} dangerouslySetInnerHTML={{ __html: html }} />;
};
