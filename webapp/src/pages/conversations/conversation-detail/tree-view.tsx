import { useCallback, useMemo } from 'react';
import type { ConversationTreeResponse } from '../../../api';
import { layoutTree } from './tree-layout';
import { TreeNodeRow } from './tree-node-row';
import { useExclusion } from './use-exclusion';

interface TreeViewProps {
    chatId: number;
    tree: ConversationTreeResponse;
    member: boolean;
    // Re-reads the tree (exclusions shift every #N)
    onChanged: () => void;
}

/** The conversation as an indented tree, with the member-only exclude / restore actions */
export const TreeView = ({ chatId, tree, member, onChanged }: TreeViewProps) => {
    const rows = useMemo(() => layoutTree(tree.nodes), [tree.nodes]);
    const { setExcluded, pendingMessageId, failure, clearFailure } = useExclusion(chatId, onChanged);

    const exclude = useCallback((messageId: number) => setExcluded(messageId, true), [setExcluded]);
    const restore = useCallback((messageId: number) => setExcluded(messageId, false), [setExcluded]);

    return (
        <>
            {failure !== null && (
                <div className="notice warning">
                    <p>{failure.message}</p>
                    <button type="button" className="button secondary" onClick={clearFailure}>
                        知道了
                    </button>
                </div>
            )}
            {rows.length === 0 ? (
                <p className="placeholder">会话是空的</p>
            ) : (
                <ul className="tree">
                    {rows.map((row) => (
                        <TreeNodeRow
                            key={row.node.messageId}
                            row={row}
                            chatId={chatId}
                            member={member}
                            pendingMessageId={pendingMessageId}
                            onExclude={exclude}
                            onRestore={restore}
                        />
                    ))}
                </ul>
            )}
        </>
    );
};
