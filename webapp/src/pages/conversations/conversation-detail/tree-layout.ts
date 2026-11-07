import type { TreeNode } from '../../../api';

// Deeper levels are not indented further; they show "↳ 回复 #N" instead, so a phone screen keeps its width
const MAX_INDENT_DEPTH = 3;

export interface TreeRow {
    node: TreeNode;
    // Indentation level, capped
    depth: number;
    // For levels past the cap: the #N of the message this one hangs under
    parentNumber: number | null;
}

const childrenByParentOf = (nodes: readonly TreeNode[]): Map<number | null, TreeNode[]> => {
    const byId = new Map(nodes.map((node) => [node.messageId, node]));
    const children = new Map<number | null, TreeNode[]>();
    for (const node of nodes) {
        const parentId = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
        const siblings = children.get(parentId) ?? [];
        siblings.push(node);
        children.set(parentId, siblings);
    }
    return children;
};

const byMessageId = (left: TreeNode, right: TreeNode): number => left.messageId - right.messageId;

/**
 * The tree as an ordered list of rows: depth-first, siblings by message id
 * (chronological). Anything whose parent is missing, or left over by a broken
 * edge, is shown at the top level rather than hidden.
 */
export const layoutTree = (nodes: readonly TreeNode[]): TreeRow[] => {
    const byId = new Map(nodes.map((node) => [node.messageId, node]));
    const children = childrenByParentOf(nodes);
    const rows: TreeRow[] = [];
    const visited = new Set<number>();

    const walk = (parentId: number | null, depth: number): void => {
        const siblings = [...(children.get(parentId) ?? [])].sort(byMessageId);
        for (const node of siblings) {
            if (visited.has(node.messageId)) continue;
            visited.add(node.messageId);
            const parentNumber =
                depth > MAX_INDENT_DEPTH && node.parentId !== null ? (byId.get(node.parentId)?.number ?? null) : null;
            rows.push({ node, depth: Math.min(depth, MAX_INDENT_DEPTH), parentNumber });
            walk(node.messageId, depth + 1);
        }
    };
    walk(null, 0);

    for (const node of [...nodes].sort(byMessageId)) {
        if (visited.has(node.messageId)) continue;
        visited.add(node.messageId);
        rows.push({ node, depth: 0, parentNumber: null });
    }
    return rows;
};
