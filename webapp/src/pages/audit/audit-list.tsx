import type { AuditEntry, ChatSummary } from '../../api';
import { AuditEntryItem } from '../../components/audit-entry-item';
import { auditScopeLabel } from '../../format';
import { useAuditPagination } from './use-audit-pagination';

interface AuditListProps {
    // null = global view, where each entry also shows its scope
    chatId: number | null;
    firstPage: readonly AuditEntry[];
    chats: readonly ChatSummary[];
}

export const AuditList = ({ chatId, firstPage, chats }: AuditListProps) => {
    const { entries, hasMore, loadMoreState, loadMore } = useAuditPagination(chatId, firstPage);

    if (entries.length === 0) return <p className="placeholder">还没有设置改动</p>;
    return (
        <>
            <ul className="list">
                {entries.map((entry) => (
                    <AuditEntryItem
                        key={entry.id}
                        entry={entry}
                        scopeLabel={chatId === null ? auditScopeLabel(entry.scope, chats) : null}
                        showChange
                    />
                ))}
            </ul>
            {loadMoreState.kind === 'failed' && <p className="error-text">{loadMoreState.message}</p>}
            {hasMore && (
                <button
                    type="button"
                    className="button secondary"
                    disabled={loadMoreState.kind === 'loading'}
                    onClick={loadMore}
                >
                    {loadMoreState.kind === 'loading' ? '加载中…' : '加载更多'}
                </button>
            )}
        </>
    );
};
