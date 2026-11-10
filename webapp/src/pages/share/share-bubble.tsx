import type { PublicShareBubble } from '../../api';
import { FoldableText } from '../../components/foldable-text';
import { formatDateTime } from '../../format';
import { ShareMediaAttachment } from './share-attachments';
import { ShareWidgetView } from './share-widget-view';

const BOT_AUTHOR_NAME = 'k-on-bot';

const authorNameOf = (bubble: PublicShareBubble): string =>
    bubble.kind === 'bot' ? BOT_AUTHOR_NAME : (bubble.authorName ?? '用户');

interface ShareBubbleProps {
    token: string;
    bubble: PublicShareBubble;
    // Position among the page's widgets; null when this bubble has none
    widgetIndex: number | null;
    // This is the first widget of the page: scroll it into view once
    autoFocusWidget?: boolean;
}

/** One message of a conversation share: author, text and its attachment */
export const ShareBubble = ({ token, bubble, widgetIndex, autoFocusWidget = false }: ShareBubbleProps) => {
    const authorName = authorNameOf(bubble);

    return (
        <article className={`share-bubble ${bubble.kind}`}>
            <p className="share-bubble-head">
                <span className="share-bubble-author">{authorName}</span>
                <span className="hint">{formatDateTime(bubble.createdAt)}</span>
            </p>
            {bubble.text === '' ? (
                <p className="hint">（无正文）</p>
            ) : (
                <FoldableText text={bubble.text} foldLines={10} foldChars={600} />
            )}
            {bubble.media !== null && (
                <ShareMediaAttachment token={token} messageId={bubble.messageId} media={bubble.media} />
            )}
            {bubble.previewMedia.map((preview, index) => (
                <ShareMediaAttachment
                    key={`${preview.kind}:${preview.sizeBytes ?? 0}:${index}`}
                    token={token}
                    messageId={bubble.messageId}
                    media={preview}
                    slot="preview"
                    index={index}
                />
            ))}
            {bubble.media === null && bubble.mediaHint !== null && <p className="hint">[{bubble.mediaHint}]</p>}
            {bubble.widget !== null && widgetIndex !== null && (
                <ShareWidgetView
                    token={token}
                    index={widgetIndex}
                    caption={bubble.widget.caption}
                    autoFocus={autoFocusWidget}
                />
            )}
        </article>
    );
};
