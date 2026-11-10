interface PreviewBubbleProps {
    /** Complete HTML fragment from renderedToPreviewHtml; styles are included */
    html: string;
}

/**
 * The Telegram-style preview bubble. The HTML is generated locally from the
 * markdown the user typed (the library escapes every text run), never raw
 * user-supplied HTML.
 */
export const PreviewBubble = ({ html }: PreviewBubbleProps) => (
    <div className="tools-preview" dangerouslySetInnerHTML={{ __html: html }} />
);
