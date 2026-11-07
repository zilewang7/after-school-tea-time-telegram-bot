import { describeReadFailure } from '../../../api';
import { ErrorView, LoadingView } from '../../../components/status-views';
import type { ConversationListState } from './conversation-list-state';
import { ConversationRow } from './conversation-row';

interface ConversationListViewProps {
    chatId: number;
    state: ConversationListState;
    onLoadMore: () => void;
    onRetry: () => void;
}

/**
 * The rows with 「加载更多」. A background reload keeps the old rows dimmed
 * instead of a loading flash; a failed first page replaces them with the error.
 */
export const ConversationListView = ({ chatId, state, onLoadMore, onRetry }: ConversationListViewProps) => {
    const { data, request, failure } = state;
    if (failure !== null && (data === null || failure.kind === 'first')) {
        return <ErrorView failure={failure.failure} onRetry={onRetry} />;
    }
    if (data === null) return <LoadingView />;

    const refreshing = request?.kind === 'first';
    const loadingMore = request?.kind === 'next';
    return (
        <div className={refreshing ? 'conversation-list refreshing' : 'conversation-list'} aria-busy={refreshing}>
            {data.conversations.length === 0 ? (
                <p className="placeholder">最近 7 天还没有会话</p>
            ) : (
                <ul className="list">
                    {data.conversations.map((item) => (
                        <ConversationRow key={item.rootId} chatId={chatId} item={item} />
                    ))}
                </ul>
            )}
            {failure?.kind === 'next' && (
                <div className="save-failure">
                    <p className="error-text">{describeReadFailure(failure.failure)}</p>
                    <button type="button" className="button secondary" onClick={onRetry}>
                        重试
                    </button>
                </div>
            )}
            {failure === null && !refreshing && data.nextBefore !== null && (
                <button type="button" className="button secondary" disabled={loadingMore} onClick={onLoadMore}>
                    {loadingMore ? '加载中…' : '加载更多'}
                </button>
            )}
        </div>
    );
};
