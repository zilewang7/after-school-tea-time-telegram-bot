import type { TreeNode } from '../../../api';
import { BotNodeRow } from './bot-node-row';
import type { TreeRow } from './tree-layout';
import { UserNodeRow } from './user-node-row';

interface TreeNodeRowProps {
    row: TreeRow;
    chatId: number;
    member: boolean;
    pendingMessageId: number | null;
    onExclude: (messageId: number) => void;
    onRestore: (messageId: number) => void;
}

/** One row of the tree, dispatched by the node kind */
export const TreeNodeRow = ({ row, chatId, member, pendingMessageId, onExclude, onRestore }: TreeNodeRowProps) => {
    const node: TreeNode = row.node;
    const pending = pendingMessageId === node.messageId;
    if (node.kind === 'bot') {
        return (
            <BotNodeRow
                row={row}
                node={node}
                chatId={chatId}
                member={member}
                pending={pending}
                onExclude={onExclude}
                onRestore={onRestore}
            />
        );
    }
    return (
        <UserNodeRow
            row={row}
            node={node}
            member={member}
            pending={pending}
            onExclude={onExclude}
            onRestore={onRestore}
        />
    );
};
