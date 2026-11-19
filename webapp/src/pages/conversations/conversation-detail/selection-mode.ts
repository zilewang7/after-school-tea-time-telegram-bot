/**
 * The pure part of the conversation's multi-select mode (design 2026-1119-2016
 * §4.6): the selected set, how it splits into "can be excluded" / "can be
 * restored", the one-line summary of a row and the batch-size limit. Kept free
 * of React so the offline cases can drive it directly.
 */
import type { TreeNode } from '../../../api/types';

/** The server takes 1–100 ids per batch write */
export const MAX_BATCH_MESSAGES = 100;

/** How much of a message the compact selection list shows */
export const SUMMARY_CHARS = 80;

const NO_SELECTION: ReadonlySet<number> = new Set<number>();

/** No row selected */
export const emptySelection = (): ReadonlySet<number> => NO_SELECTION;

/** The selected set after tapping one row */
export const toggleSelected = (selected: ReadonlySet<number>, messageId: number): ReadonlySet<number> => {
    const next = new Set(selected);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    return next;
};

/** Every row of the list selected (全选) */
export const allSelectedOf = (nodes: readonly TreeNode[]): ReadonlySet<number> =>
    new Set(nodes.map((node) => node.messageId));

/** How the selection splits by the state each message is in now */
export interface SelectionGroups {
    /** Selected and in the context: a batch exclude takes them out */
    excludable: number[];
    /** Selected and excluded: a batch restore puts them back */
    restorable: number[];
}

/** The rows of `nodes` that are selected, split by their current excluded state */
export const selectionGroupsOf = (
    selected: ReadonlySet<number>,
    nodes: readonly TreeNode[]
): SelectionGroups => {
    const groups: SelectionGroups = { excludable: [], restorable: [] };
    for (const node of nodes) {
        if (!selected.has(node.messageId)) continue;
        if (node.excluded) groups.restorable.push(node.messageId);
        else groups.excludable.push(node.messageId);
    }
    return groups;
};

/** How many rows the actions would submit (a row that left the tree is not counted) */
export const selectedCountOf = (groups: SelectionGroups): number =>
    groups.excludable.length + groups.restorable.length;

/** Above the server's per-write limit the UI refuses to submit */
export const exceedsBatchLimit = (count: number): boolean => count > MAX_BATCH_MESSAGES;

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `text` cut to SUMMARY_CHARS characters (the whole text when it is shorter) */
const truncated = (text: string): string => {
    const characters = Array.from(text);
    if (characters.length <= SUMMARY_CHARS) return text;
    return `${characters.slice(0, SUMMARY_CHARS).join('')}…`;
};

const summaryOfText = (text: string | null): string | null => {
    const flat = text === null ? '' : flatten(text);
    return flat === '' ? null : truncated(flat);
};

/** One line of the compact list: the text a member reads, or what media it carries */
export const selectionSummaryOf = (node: TreeNode): string | null => {
    if (node.kind === 'bot') return summaryOfText(node.reply.text);
    if (node.redacted) return null;
    return summaryOfText(node.text !== null && node.text !== '' ? node.text : node.mediaHint);
};
