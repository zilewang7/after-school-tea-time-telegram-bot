import { useMemo } from 'react';
import type { PublicShareBubble, PublicShareReplyTarget } from '../../api';
import { FoldableText } from '../../components/foldable-text';
import { formatDateTime } from '../../format';
import { unreferencedMediaIndexes } from '../../rich/rich-answer';
import { RichAnswerFigure, RichAnswerView } from '../../rich/rich-answer-view';
import { shareRichAnswerBlocksOf, shareRichMediaItemsOf } from '../../share/share-rich-media';
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
    // A bot bubble of a v5.3 rich reply carries its answer snapshot: the body
    // renders with its pictures in place. A user bubble never has one.
    const richBlocks = useMemo(
        () => (bubble.kind === 'bot' ? shareRichAnswerBlocksOf(bubble.richAnswerMarkdown, bubble.media) : null),
        [bubble.kind, bubble.richAnswerMarkdown, bubble.media]
    );
    const richMedia = useMemo(
        () => (richBlocks === null ? [] : shareRichMediaItemsOf(token, bubble.media)),
        [richBlocks, token, bubble.media]
    );
    const leftoverIndexes = useMemo(
        () => (richBlocks === null ? [] : unreferencedMediaIndexes(richBlocks, bubble.media.length)),
        [richBlocks, bubble.media.length]
    );

    // A deleted message starts folded; its head stays visible. Its widget must
    // not scroll into view while the body is hidden.
    const deleted = bubble.deleted;
    const head = (
        <>
            <span className="share-bubble-author">{authorName}</span>
            {deleted && <span className="badge">已删除</span>}
            <span className="hint">{formatDateTime(bubble.createdAt)}</span>
        </>
    );
    const body = (
        <>
            {bubble.replyTo !== null && <ReplyTargetLine target={bubble.replyTo} />}
            {quote !== null && quote !== '' && <blockquote className="quote">{quote}</blockquote>}
            {richBlocks !== null ? (
                <RichAnswerView blocks={richBlocks} media={richMedia} appendUnreferenced={false} />
            ) : bubble.text === '' ? (
                <p className="hint">（无正文）</p>
            ) : (
                <FoldableText text={bubble.text} foldLines={10} foldChars={600} />
            )}
            {richBlocks === null
                ? bubble.media.map((item, index) => (
                      <ShareMediaAttachment
                          key={`${item.messageId}:${item.mimeType}:${index}`}
                          token={token}
                          messageId={item.messageId}
                          media={item}
                          index={item.index}
                      />
                  ))
                : leftoverIndexes.map((index) => (
                      <RichAnswerFigure
                          key={`leftover:${index}`}
                          media={richMedia}
                          mediaIndex={index}
                          compact={false}
                          showCaptions
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
                    autoFocus={autoFocusWidget && !deleted}
                />
            )}
        </>
    );

    return (
        <article className={`share-bubble ${bubble.kind}`}>
            {deleted ? (
                <details className="share-fold">
                    <summary className="share-bubble-head">{head}</summary>
                    <div className="share-fold-body">{body}</div>
                </details>
            ) : (
                <>
                    <p className="share-bubble-head">{head}</p>
                    {body}
                </>
            )}
        </article>
    );
};
