import { useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import type { BotNode, ToolUsageView } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { FoldableText } from '../../../components/foldable-text';
import { formatDateTime } from '../../../format';
import { replyPath } from '../../../routing/paths';
import { NodeMenu } from './node-menu';
import type { TreeRow } from './tree-layout';

const INDENT_PX = 16;
const ERROR_PREVIEW_CHARS = 200;

const toolLineOf = (toolSummary: readonly ToolUsageView[]): string | null => {
    if (toolSummary.length === 0) return null;
    const parts = toolSummary.map(
        (tool) => `${tool.name} ×${tool.count}${tool.failed > 0 ? `（${tool.failed} 次失败）` : ''}`
    );
    return `工具 ${parts.join(' · ')}`;
};

const previewOf = (text: string): string => {
    const characters = Array.from(text);
    return characters.length <= ERROR_PREVIEW_CHARS ? text : `${characters.slice(0, ERROR_PREVIEW_CHARS).join('')}…`;
};

const versionLabelOf = (node: BotNode): string | null => {
    const { versionCount, currentVersion } = node.reply;
    if (versionCount === 0) return null;
    return `v${currentVersion ?? versionCount}/${versionCount}`;
};

interface BotNodeRowProps {
    row: TreeRow;
    node: BotNode;
    chatId: number;
    member: boolean;
    pending: boolean;
    onExclude: (messageId: number) => void;
    onRestore: (messageId: number) => void;
}

/**
 * One bot reply in the tree: the current version's text and its collapsed
 * thinking / tool records. Tapping the text opens the reply detail (versions,
 * metrics, full tool records).
 */
export const BotNodeRow = ({ row, node, chatId, member, pending, onExclude, onRestore }: BotNodeRowProps) => {
    const style = useMemo<{ marginLeft: string }>(() => ({ marginLeft: `${row.depth * INDENT_PX}px` }), [row.depth]);
    const reply = node.reply;
    const versionLabel = versionLabelOf(node);
    const toolLine = useMemo(() => toolLineOf(reply.toolSummary), [reply.toolSummary]);
    const thinkingText = reply.thinkingText;
    const thinkingLength = useMemo(
        () => (thinkingText === null ? 0 : Array.from(thinkingText).length),
        [thinkingText]
    );
    const detailPath = replyPath(chatId, node.messageId);
    const handleExclude = useCallback(() => onExclude(node.messageId), [onExclude, node.messageId]);
    const handleRestore = useCallback(() => onRestore(node.messageId), [onRestore, node.messageId]);

    return (
        <li className={node.excluded ? 'tree-node bot-node excluded' : 'tree-node bot-node'} style={style}>
            <div className="tree-node-head">
                <span className={node.excluded ? 'tree-number excluded' : 'tree-number'}>
                    {node.number === null ? '┄' : `#${node.number}`}
                </span>
                {row.parentNumber !== null && <span className="hint">↳ 回复 #{row.parentNumber}</span>}
                <span className="tree-author">bot</span>
                {versionLabel !== null && <span className="badge">{versionLabel}</span>}
                {reply.model !== null && <span className="hint">{reply.model}</span>}
                {reply.wasStoppedByUser && <span className="badge">已停止</span>}
                {node.excluded && <span className="badge warning">已排除</span>}
                <span className="hint tree-date">{formatDateTime(node.date)}</span>
                {member && (
                    <NodeMenu node={node} member pending={pending} onExclude={handleExclude} onRestore={handleRestore} />
                )}
            </div>

            <Link className="tree-node-body" to={detailPath}>
                {reply.text === null || reply.text === '' ? (
                    <p className="hint">（无正文，点开看版本详情）</p>
                ) : (
                    <p className="tree-node-text">{reply.text}</p>
                )}
            </Link>

            {thinkingText !== null && thinkingText !== '' && (
                <CollapsibleSection title="思考" summary={`${thinkingLength} 字`}>
                    <FoldableText text={thinkingText} foldLines={10} />
                </CollapsibleSection>
            )}
            {toolLine !== null && <p className="hint">{toolLine}</p>}
            {reply.errorMessage !== null && (
                <p className="error-text prewrap">⚠ {previewOf(reply.errorMessage)}</p>
            )}
        </li>
    );
};
