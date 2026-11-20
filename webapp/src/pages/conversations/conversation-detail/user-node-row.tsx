import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { MemberUserNode, ObserverUserNode, TreeEdge } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { MediaAttachmentView } from '../../../components/media-attachment-view';
import { FoldableText } from '../../../components/foldable-text';
import { formatDateTime } from '../../../format';
import { NodeMenu } from './node-menu';
import { treeEdgeLabelOf } from './tree-edge-label';
import type { TreeRow } from './tree-layout';

const INDENT_PX = 16;

interface UserNodeRowProps {
    row: TreeRow;
    node: MemberUserNode | ObserverUserNode;
    // Members may exclude and restore
    member: boolean;
    pending: boolean;
    onExclude: (messageId: number) => void;
    onRestore: (messageId: number) => void;
}

const indentStyleOf = (depth: number): { marginLeft: string } => ({ marginLeft: `${depth * INDENT_PX}px` });

const numberLabelOf = (number: number | null): string => (number === null ? '┄' : `#${number}`);

interface NodeHeadProps {
    number: number | null;
    excluded: boolean;
    date: string;
    parentNumber: number | null;
    // How this row hangs under its parent: a /chat link is not a reply
    edge: TreeEdge | null;
    children: ReactNode;
}

const NodeHead = ({ number, excluded, date, parentNumber, edge, children }: NodeHeadProps) => {
    const edgeLabel = treeEdgeLabelOf(edge, parentNumber);
    return (
        <div className="tree-node-head">
            <span className={excluded ? 'tree-number excluded' : 'tree-number'}>{numberLabelOf(number)}</span>
            {edgeLabel.hint !== null && <span className="hint">{edgeLabel.hint}</span>}
            {edgeLabel.badge !== null && <span className="badge">{edgeLabel.badge}</span>}
            {children}
            <span className="hint tree-date">{formatDateTime(date)}</span>
        </div>
    );
};

/** One user message: full for members, an eight-field placeholder for observers */
export const UserNodeRow = ({ row, node, member, pending, onExclude, onRestore }: UserNodeRowProps) => {
    const style = useMemo(() => indentStyleOf(row.depth), [row.depth]);
    const handleExclude = useCallback(() => onExclude(node.messageId), [onExclude, node.messageId]);
    const handleRestore = useCallback(() => onRestore(node.messageId), [onRestore, node.messageId]);
    const excluded = node.excluded;

    if (node.redacted) {
        const label = `用户消息（仅成员可见${excluded ? '，已排除' : ''}）`;
        const badge = treeEdgeLabelOf(node.edge, row.parentNumber).badge;
        return (
            <li className={excluded ? 'tree-node excluded' : 'tree-node'} style={style}>
                <p className="hint">
                    {badge !== null ? `${badge} · ` : ''}
                    {numberLabelOf(node.number)} · {label} · {formatDateTime(node.date)}
                </p>
            </li>
        );
    }

    // A deleted or excluded message starts folded; its head stays visible.
    const folded = excluded || node.deleted;
    const body = (
        <>
            {node.annotations.length > 0 && <p className="hint tree-annotations">{node.annotations.join(' ')}</p>}
            {node.quote !== null && <blockquote className="quote">{node.quote}</blockquote>}

            {node.text !== null && node.text !== '' && <FoldableText text={node.text} />}
            {node.media.map((item) => (
                <MediaAttachmentView key={item.url} media={item} compact />
            ))}
            {node.previewMedia.map((preview) => (
                <MediaAttachmentView key={preview.url} media={preview} compact />
            ))}
            {node.media.length === 0 && node.mediaHint !== null && <p className="hint">[{node.mediaHint}]</p>}
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
        </>
    );

    return (
        <li className={excluded ? 'tree-node user-node excluded' : 'tree-node user-node'} style={style}>
            <NodeHead
                number={node.number}
                excluded={excluded}
                date={node.date}
                parentNumber={row.parentNumber}
                edge={node.edge}
            >
                <span className="tree-author">{node.author.name}</span>
                {node.author.username !== null && <span className="chat-username">@{node.author.username}</span>}
                {node.deleted && <span className="badge">已删除</span>}
                {excluded && <span className="badge warning">已排除</span>}
                {member && (
                    <NodeMenu
                        node={node}
                        member
                        pending={pending}
                        onExclude={handleExclude}
                        onRestore={handleRestore}
                    />
                )}
            </NodeHead>

            {folded ? (
                <details className="node-fold">
                    <summary className="node-fold-summary">内容</summary>
                    <div className="node-fold-body">{body}</div>
                </details>
            ) : (
                body
            )}
        </li>
    );
};
