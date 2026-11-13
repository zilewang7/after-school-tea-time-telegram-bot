import type { PublicShareBubble, PublicShareReplyTarget } from '../../api';
import { FoldableText } from '../../components/foldable-text';
import { formatDateTime } from '../../format';
import { ShareMediaAttachment } from './share-attachments';
import { ShareWidgetView } from './share-widget-view';

const BOT_AUTHOR_NAME = 'k-on-bot';

const authorNameOf = (bubble: PublicShareBubble): string =>
    bubble.kind === 'bot' ? BOT_AUTHOR_NAME : (bubble.authorName ?? '用户');

const targetSnippetOf = (target: PublicShareReplyTarget): string | null =>
    target.snippet ?? (target.mediaHint === null ? null : `[${target.mediaHint}]`);

/** The message a bubble answers: `↳ 回复 黑猫：…` */
const ReplyTargetLine = ({ target }: { target: PublicShareReplyTarget }) => {
    const snippet = targetSnippetOf(target);
    return (
        <p className="share-reply-to">
            ↳ 回复 <span className="share-reply-to-author">{target.authorName}</span>
            {snippet === null ? '' : `：${snippet}`}
        </p>
    );
};

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
    const quote = bubble.quote ?? null;
    const previewText = bubble.previewText ?? null;

    return (
        <article className={`share-bubble ${bubble.kind}`}>
            <p className="share-bubble-head">
                <span className="share-bubble-author">{authorName}</span>
                <span className="hint">{formatDateTime(bubble.createdAt)}</span>
            </p>
            {bubble.replyTo !== null && <ReplyTargetLine target={bubble.replyTo} />}
            {quote !== null && quote !== '' && <blockquote className="quote">{quote}</blockquote>}
            {bubble.text === '' ? (
                <p className="hint">（无正文）</p>
            ) : (
                <FoldableText text={bubble.text} foldLines={10} foldChars={600} />
            )}
            {bubble.media.map((item, index) => (
                <ShareMediaAttachment
                    key={`${item.messageId}:${item.mimeType}:${index}`}
                    token={token}
                    messageId={item.messageId}
                    media={item}
                />
            ))}
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
            {bubble.media.length === 0 && bubble.mediaHint !== null && <p className="hint">[{bubble.mediaHint}]</p>}
            {previewText !== null && previewText !== '' && (
                <details className="share-preview-text">
                    <summary className="hint">网页预览</summary>
                    <FoldableText text={previewText} foldLines={10} foldChars={800} />
                </details>
            )}
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
