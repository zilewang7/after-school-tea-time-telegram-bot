import { useMemo } from 'react';
import type { PublicShareReply } from '../../api';
import { FoldableText } from '../../components/foldable-text';
import { formatDateTime } from '../../format';
import { unreferencedMediaIndexes } from '../../rich/rich-answer';
import { RichAnswerFigure, RichAnswerView } from '../../rich/rich-answer-view';
import { shareRichAnswerBlocksOf, shareRichMediaOf } from '../../share/share-rich-media';
import { ShareMediaAttachment } from './share-attachments';
import { ShareReactions } from './share-reactions';
import { ShareWidgetView } from './share-widget-view';

interface ShareReplyContentProps {
    token: string;
    reply: PublicShareReply;
}

/** A reply share's pinned version: body, widget card, image and file — nothing editable */
export const ShareReplyContent = ({ token, reply }: ShareReplyContentProps) => {
    // A v5.3 rich version carries its answer snapshot: the body renders with its
    // pictures in place. Everything the snapshot does not place follows the widget,
    // the way the chat showed the trailing messages.
    const richBlocks = useMemo(
        () => shareRichAnswerBlocksOf(reply.richAnswerMarkdown, reply.media),
        [reply.richAnswerMarkdown, reply.media]
    );
    const richMedia = useMemo(
        () => (richBlocks === null ? [] : shareRichMediaOf(token, reply.firstMessageId, reply.media)),
        [richBlocks, token, reply.firstMessageId, reply.media]
    );
    const leftoverIndexes = useMemo(
        () => (richBlocks === null ? [] : unreferencedMediaIndexes(richBlocks, reply.media.length)),
        [richBlocks, reply.media.length]
    );
    return (
        <section className="section">
            <p className="badges">
                <span className="badge accent">{reply.model ?? '模型未知'}</span>
                <span className="badge">第 {reply.versionNumber} 版</span>
                <span className="badge">{formatDateTime(reply.createdAt)}</span>
            </p>
            {richBlocks === null ? (
                reply.text === '' ? (
                    <p className="hint">这一版没有正文</p>
                ) : (
                    <FoldableText text={reply.text} foldLines={12} foldChars={900} />
                )
            ) : (
                <RichAnswerView blocks={richBlocks} media={richMedia} appendUnreferenced={false} />
            )}
            {reply.widget !== null && (
                <ShareWidgetView token={token} index={0} caption={reply.widget.caption} autoFocus />
            )}
            {richBlocks === null
                ? reply.media.map((media, index) => (
                      <ShareMediaAttachment
                          key={`${media.mimeType}:${index}`}
                          token={token}
                          messageId={reply.firstMessageId}
                          media={media}
                          index={index === 0 ? undefined : index}
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
            <ShareReactions reactions={reply.reactions ?? []} />
        </section>
    );
};
