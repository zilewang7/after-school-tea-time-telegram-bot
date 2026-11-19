/**
 * The conversation's multi-select mode (design 2026-1119-2016 §4.6): the tree
 * as a compact checklist plus one sticky action bar. A row is a single button
 * (role="checkbox") whose tick is visual only, so no interactive element nests
 * inside another; the order and indentation come from `layoutTree`.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ConversationTreeResponse, TreeNode } from '../../../api';
import { formatDateTime } from '../../../format';
import { useConfirm } from '../../../hooks/use-telegram-feedback';
import {
    allSelectedOf,
    emptySelection,
    exceedsBatchLimit,
    MAX_BATCH_MESSAGES,
    selectedCountOf,
    selectionGroupsOf,
    selectionSummaryOf,
    toggleSelected,
} from './selection-mode';
import { layoutTree, type TreeRow } from './tree-layout';
import type { BatchExclusion } from './use-batch-exclusion';

const INDENT_PX = 16;

const excludeConfirmText = (count: number): string =>
    `排除所选 ${count} 条消息后，它们不再进入模型上下文（对整个聊天生效），之后可以恢复。确定排除？`;
const restoreConfirmText = (count: number): string =>
    `恢复所选 ${count} 条消息后，它们会重新进入模型上下文（对整个聊天生效），之后也可以再排除。确定恢复？`;

const numberLabelOf = (number: number | null): string => (number === null ? '┄' : `#${number}`);

const authorLabelOf = (node: TreeNode): string => {
    if (node.kind === 'bot') return 'bot';
    return node.redacted ? '用户消息' : node.author.name;
};

const deletedOf = (node: TreeNode): boolean => {
    if (node.kind === 'bot') return node.deleted;
    return node.redacted ? false : node.deleted;
};

interface SelectionRowProps {
    row: TreeRow;
    checked: boolean;
    onToggle: (messageId: number) => void;
}

/** One optional row: the head of the tree node plus a one-line summary */
const SelectionRow = ({ row, checked, onToggle }: SelectionRowProps) => {
    const node = row.node;
    const style = useMemo<{ marginLeft: string }>(() => ({ marginLeft: `${row.depth * INDENT_PX}px` }), [row.depth]);
    const summary = useMemo(() => selectionSummaryOf(node), [node]);
    const handleToggle = useCallback(() => onToggle(node.messageId), [onToggle, node.messageId]);

    return (
        <li style={style}>
            <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                className="selection-row"
                onClick={handleToggle}
            >
                <span className="selection-check" aria-hidden="true">
                    {checked ? '✓' : ''}
                </span>
                <span className={node.excluded ? 'tree-number excluded' : 'tree-number'}>
                    {numberLabelOf(node.number)}
                </span>
                <span className="tree-author">{authorLabelOf(node)}</span>
                {node.excluded && <span className="badge warning">已排除</span>}
                {deletedOf(node) && <span className="badge">已删除</span>}
                <span className="hint tree-date">{formatDateTime(node.date)}</span>
                {summary !== null && <span className="selection-summary">{summary}</span>}
            </button>
        </li>
    );
};

interface SelectionViewProps {
    tree: ConversationTreeResponse;
    batch: BatchExclusion;
    /** Leaving the mode: the tree takes the screen back */
    onExit: () => void;
}

/** The whole checklist, the sticky action bar, the confirm and the failure notice */
export const SelectionView = ({ tree, batch, onExit }: SelectionViewProps) => {
    const confirm = useConfirm();
    const [selected, setSelected] = useState<ReadonlySet<number>>(emptySelection);
    const rows = useMemo(() => layoutTree(tree.nodes), [tree.nodes]);
    const groups = useMemo(() => selectionGroupsOf(selected, tree.nodes), [selected, tree.nodes]);
    const selectedCount = selectedCountOf(groups);
    const overLimit = exceedsBatchLimit(selectedCount);
    const pending = batch.pending !== null;
    const { submit, failure, clearFailure } = batch;

    const toggle = useCallback(
        (messageId: number) => setSelected((current) => toggleSelected(current, messageId)),
        []
    );
    const selectAll = useCallback(() => setSelected(allSelectedOf(tree.nodes)), [tree.nodes]);
    const clear = useCallback(() => setSelected(emptySelection()), []);
    const exit = useCallback(() => {
        if (!pending) onExit();
    }, [onExit, pending]);

    const run = useCallback(
        (action: 'exclude' | 'restore', messageIds: readonly number[], count: number) => {
            if (pending || count === 0) return;
            const text = action === 'exclude' ? excludeConfirmText(count) : restoreConfirmText(count);
            void confirm(text).then((confirmed) => {
                if (!confirmed) return;
                // The parent leaves the mode when the write went through; a failure keeps the selection
                void submit(action, messageIds).then((succeeded) => {
                    if (succeeded) onExit();
                });
            });
        },
        [confirm, onExit, pending, submit]
    );

    const excludeSelected = useCallback(
        () => run('exclude', groups.excludable, groups.excludable.length),
        [run, groups.excludable]
    );
    const restoreSelected = useCallback(
        () => run('restore', groups.restorable, groups.restorable.length),
        [run, groups.restorable]
    );

    return (
        <>
            <p className="hint">
                点一行勾选。排除的消息不再进入模型上下文，恢复的消息会重新进入；一次最多选 {MAX_BATCH_MESSAGES} 条。
            </p>
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
                <ul className="selection-list">
                    {rows.map((row) => (
                        <SelectionRow
                            key={row.node.messageId}
                            row={row}
                            checked={selected.has(row.node.messageId)}
                            onToggle={toggle}
                        />
                    ))}
                </ul>
            )}
            <div className="selection-bar">
                <div className="selection-bar-status">
                    <span>已选 {selectedCount} 条</span>
                    {overLimit && (
                        <span className="selection-limit">一次最多选 {MAX_BATCH_MESSAGES} 条，请取消一些</span>
                    )}
                    {pending && <span className="hint">提交中…</span>}
                </div>
                <div className="selection-bar-actions">
                    <button
                        type="button"
                        className="button primary"
                        disabled={groups.excludable.length === 0 || pending || overLimit}
                        onClick={excludeSelected}
                    >
                        排除所选 {groups.excludable.length} 条
                    </button>
                    <button
                        type="button"
                        className="button secondary"
                        disabled={groups.restorable.length === 0 || pending || overLimit}
                        onClick={restoreSelected}
                    >
                        恢复所选 {groups.restorable.length} 条
                    </button>
                    <button type="button" className="button secondary" disabled={pending} onClick={selectAll}>
                        全选
                    </button>
                    <button
                        type="button"
                        className="button secondary"
                        disabled={pending || selectedCount === 0}
                        onClick={clear}
                    >
                        清空
                    </button>
                    <button type="button" className="button secondary" disabled={pending} onClick={exit}>
                        退出
                    </button>
                </div>
            </div>
        </>
    );
};
