/**
 * How one tree row hangs under its parent, as the row head shows it. A reply is
 * the default; a /chat link and a reply target are not replies, and from the
 * indentation alone they would read as one.
 */
import { match } from 'ts-pattern';
import type { TreeEdge } from '../../../api';

export interface TreeEdgeLabel {
    /** The "↳ ..." hint a deep row shows instead of more indentation; null on a root */
    hint: string | null;
    /** A head badge for the edges indentation cannot tell apart from a reply */
    badge: string | null;
}

const hintOf = (relation: string, parentNumber: number | null): string | null =>
    parentNumber === null ? null : `↳ ${relation} #${parentNumber}`;

/** The hint and badge of one row, by the edge that places it on the tree */
export const treeEdgeLabelOf = (edge: TreeEdge | null, parentNumber: number | null): TreeEdgeLabel =>
    match(edge)
        .returnType<TreeEdgeLabel>()
        .with('link', () => ({ hint: hintOf('拼接自', parentNumber), badge: '拼接' }))
        .with('reply-target', () => ({
            hint: parentNumber === null ? null : `↳ 被 #${parentNumber} 回复`,
            badge: '被回复',
        }))
        .with('reply', () => ({ hint: hintOf('回复', parentNumber), badge: null }))
        .with(null, () => ({ hint: hintOf('回复', parentNumber), badge: null }))
        .exhaustive();
