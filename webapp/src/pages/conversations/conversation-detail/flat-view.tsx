import { useMemo } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';
import type { BotNode, ConversationTreeResponse, MemberUserNode, ObserverUserNode, TreeNode } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { FoldableText } from '../../../components/foldable-text';
import { MediaAttachmentView } from '../../../components/media-attachment-view';
import { formatDateTime } from '../../../format';
import { replyPath } from '../../../routing/paths';
import { ReplyTargetBlock } from './reply-target-block';

interface FlatViewProps {
    chatId: number;
    tree: ConversationTreeResponse;
}

const numberLabelOf = (number: number | null): string | null => (number === null ? null : `#${number}`);

/** One user message as a chat bubble; observers get a placeholder instead (their text is redacted) */
const MemberBubble = ({ node }: { node: MemberUserNode }) => (
    <article className={node.excluded ? 'flat-bubble user excluded' : 'flat-bubble user'}>
        <p className="flat-bubble-head">
            <span className="tree-author">{node.author.name}</span>
            {node.author.username !== null && <span className="chat-username">@{node.author.username}</span>}
            {numberLabelOf(node.number) !== null && <span className="tree-number">{numberLabelOf(node.number)}</span>}
            {node.excluded && <span className="badge warning">已排除</span>}
            <span className="hint tree-date">{formatDateTime(node.date)}</span>
        </p>
        {node.replyTo !== null && <ReplyTargetBlock target={node.replyTo} />}
        {node.quote !== null && <blockquote className="quote">{node.quote}</blockquote>}
        {node.text !== null && node.text !== '' && <FoldableText text={node.text} foldLines={12} foldChars={800} />}
        {node.media !== null && <MediaAttachmentView media={node.media} />}
        {node.previewMedia.map((preview) => (
            <MediaAttachmentView key={preview.url} media={preview} />
        ))}
        {node.media === null && node.mediaHint !== null && <p className="hint">[{node.mediaHint}]</p>}
        {node.linkPreview !== null && (
            <CollapsibleSection title="网页预览" summary={null}>
                <FoldableText text={node.linkPreview} foldLines={10} />
            </CollapsibleSection>
        )}
        {node.ocrText !== null && node.ocrText !== '' && (
            <CollapsibleSection title="图片文字" summary={null}>
                <FoldableText text={node.ocrText} foldLines={10} />
            </CollapsibleSection>
        )}
    </article>
);

const ObserverBubble = ({ node }: { node: ObserverUserNode }) => (
    <article className="flat-bubble user redacted">
        <p className="flat-bubble-head">
            <span className="hint">
                用户消息（仅成员可见{numberLabelOf(node.number) === null ? '' : ` · ${numberLabelOf(node.number)}`}）
            </span>
            <span className="hint tree-date">{formatDateTime(node.date)}</span>
        </p>
    </article>
);

/** One bot reply; the text opens the reply detail, where versions and metrics live */
const BotBubble = ({ node, chatId }: { node: BotNode; chatId: number }) => {
    const reply = node.reply;
    const text = reply.text === null || reply.text === '' ? null : reply.text;
    return (
        <article className={node.excluded ? 'flat-bubble bot excluded' : 'flat-bubble bot'}>
            <p className="flat-bubble-head">
                <span className="tree-author">bot</span>
                {numberLabelOf(node.number) !== null && <span className="tree-number">{numberLabelOf(node.number)}</span>}
                {reply.versionCount > 0 && (
                    <span className="badge">
                        v{reply.currentVersion ?? reply.versionCount}/{reply.versionCount}
                    </span>
                )}
                {reply.model !== null && <span className="hint">{reply.model}</span>}
                {node.excluded && <span className="badge warning">已排除</span>}
                <span className="hint tree-date">{formatDateTime(node.date)}</span>
            </p>
            {node.replyTo !== null && <ReplyTargetBlock target={node.replyTo} />}
            {reply.versionCount === 0 ? (
                text === null ? <p className="hint">（无正文）</p> : <FoldableText text={text} foldLines={12} foldChars={800} />
            ) : (
                <Link className="flat-text-link" to={replyPath(chatId, node.messageId)}>
                    {text === null ? <p className="hint">（无正文，点开看版本详情）</p> : <FoldableText text={text} foldLines={12} foldChars={800} />}
                </Link>
            )}
            {reply.media !== null && <MediaAttachmentView media={reply.media} />}
            {reply.errorMessage !== null && <p className="error-text prewrap">⚠ {reply.errorMessage}</p>}
        </article>
    );
};

const FlatBubble = ({ node, chatId }: { node: TreeNode; chatId: number }) =>
    match(node)
        .with({ kind: 'bot' }, (bot) => <BotBubble node={bot} chatId={chatId} />)
        .with({ kind: 'user', redacted: true }, (user) => <ObserverBubble node={user} />)
        .with({ kind: 'user', redacted: false }, (user) => <MemberBubble node={user} />)
        .exhaustive();

/**
 * The conversation as the share page shows it: one flat, chronological list of
 * chat bubbles instead of the indented tree (design §10.5).
 */
export const FlatView = ({ chatId, tree }: FlatViewProps) => {
    const empty = useMemo(() => tree.nodes.length === 0, [tree.nodes.length]);
    if (empty) return <p className="placeholder">会话是空的</p>;
    return (
        <div className="flat-conversation">
            {tree.nodes.map((node) => (
                <FlatBubble key={node.messageId} node={node} chatId={chatId} />
            ))}
        </div>
    );
};
