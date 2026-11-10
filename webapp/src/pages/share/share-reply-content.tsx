import type { PublicShareReply } from '../../api';
import { FoldableText } from '../../components/foldable-text';
import { formatDateTime } from '../../format';
import { ShareMediaAttachment } from './share-attachments';
import { ShareWidgetView } from './share-widget-view';

interface ShareReplyContentProps {
    token: string;
    reply: PublicShareReply;
}

/** A reply share's pinned version: body, widget card, image and file — nothing editable */
export const ShareReplyContent = ({ token, reply }: ShareReplyContentProps) => (
    <section className="section">
        <p className="badges">
            <span className="badge accent">{reply.model ?? '模型未知'}</span>
            <span className="badge">第 {reply.versionNumber} 版</span>
            <span className="badge">{formatDateTime(reply.createdAt)}</span>
        </p>
        {reply.text === '' ? (
            <p className="hint">这一版没有正文</p>
        ) : (
            <FoldableText text={reply.text} foldLines={12} foldChars={900} />
        )}
        {reply.widget !== null && (
            <ShareWidgetView token={token} index={0} caption={reply.widget.caption} autoFocus />
        )}
        {reply.media !== null && (
            <ShareMediaAttachment token={token} messageId={reply.firstMessageId} media={reply.media} />
        )}
    </section>
);
