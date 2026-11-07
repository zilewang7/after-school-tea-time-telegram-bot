import { useCallback, useEffect, useRef } from 'react';
import type { TreeNode } from '../../../api';
import { copyText } from '../../../clipboard';
import { useConfirm } from '../../../hooks/use-telegram-feedback';

const EXCLUDE_CONFIRM_MESSAGE = '排除后这条消息不再进入模型上下文（对整个聊天生效），之后可以恢复。确定排除？';
const RESTORE_CONFIRM_MESSAGE = '恢复后这条消息会重新进入模型上下文。确定恢复？';

const textOf = (node: TreeNode): string | null => {
    if (node.kind === 'bot') return node.reply.text;
    return node.redacted ? null : node.text;
};

interface NodeMenuProps {
    node: TreeNode;
    // Members may exclude and restore; observers only copy or jump
    member: boolean;
    // An exclusion request for this node is in flight
    pending: boolean;
    onExclude: (messageId: number) => void;
    onRestore: (messageId: number) => void;
}

/** The 「⋯」 menu of a tree node: exclude / restore, open in Telegram, copy the text */
export const NodeMenu = ({ node, member, pending, onExclude, onRestore }: NodeMenuProps) => {
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const confirm = useConfirm();
    const close = useCallback(() => {
        if (detailsRef.current !== null) detailsRef.current.open = false;
    }, []);

    // A tap anywhere else closes the menu (a <details> does not do that by itself)
    useEffect(() => {
        const element = detailsRef.current;
        if (element === null) return;
        const handleDocumentClick = (event: MouseEvent): void => {
            if (!element.open) return;
            if (event.target instanceof Node && element.contains(event.target)) return;
            element.open = false;
        };
        document.addEventListener('click', handleDocumentClick);
        return () => document.removeEventListener('click', handleDocumentClick);
    }, []);

    const handleExclude = useCallback(() => {
        close();
        void confirm(EXCLUDE_CONFIRM_MESSAGE).then((confirmed) => {
            if (confirmed) onExclude(node.messageId);
        });
    }, [close, confirm, onExclude, node.messageId]);

    const handleRestore = useCallback(() => {
        close();
        void confirm(RESTORE_CONFIRM_MESSAGE).then((confirmed) => {
            if (confirmed) onRestore(node.messageId);
        });
    }, [close, confirm, onRestore, node.messageId]);

    const text = textOf(node);
    const handleCopy = useCallback(() => {
        close();
        if (text !== null && text !== '') void copyText(text);
    }, [close, text]);

    const telegramLink = node.kind === 'user' && !node.redacted ? node.telegramLink : null;
    const hasItems = member || text !== null || telegramLink !== null;
    if (!hasItems) return null;

    return (
        <details className="node-menu" ref={detailsRef}>
            <summary aria-label="消息操作">⋯</summary>
            <div className="node-menu-popup">
                {member && !node.excluded && (
                    <button type="button" disabled={pending} onClick={handleExclude}>
                        排除（不进上下文）
                    </button>
                )}
                {member && node.excluded && (
                    <button type="button" disabled={pending} onClick={handleRestore}>
                        恢复
                    </button>
                )}
                {telegramLink !== null && (
                    <a href={telegramLink} target="_blank" rel="noreferrer" onClick={close}>
                        在 Telegram 中打开
                    </a>
                )}
                {text !== null && text !== '' && (
                    <button type="button" onClick={handleCopy}>
                        复制文本
                    </button>
                )}
            </div>
        </details>
    );
};
