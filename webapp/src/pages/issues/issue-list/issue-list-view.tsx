import { describeReadFailure } from '../../../api';
import { ErrorView, LoadingView } from '../../../components/status-views';
import type { IssueListState } from './issue-list-state';
import { IssueRow } from './issue-row';

interface IssueListViewProps {
    state: IssueListState;
    showChat: boolean;
    onLoadMore: () => void;
    onRetry: () => void;
}

/**
 * The rows with 「加载更多」. While new filters load, the old rows stay dimmed
 * instead of a loading flash; a failed first page replaces them with the error.
 */
export const IssueListView = ({ state, showChat, onLoadMore, onRetry }: IssueListViewProps) => {
    const { data, request, failure } = state;
    if (failure !== null && (data === null || failure.kind === 'first')) {
        return <ErrorView failure={failure.failure} onRetry={onRetry} />;
    }
    if (data === null) return <LoadingView />;

    const refreshing = request?.kind === 'first';
    const loadingMore = request?.kind === 'next';
    return (
        <div className={refreshing ? 'issue-list refreshing' : 'issue-list'} aria-busy={refreshing}>
            {data.issues.length === 0 ? (
                <p className="placeholder">{data.filters.openOnly ? '没有未关闭的 issue' : '没有 issue'}</p>
            ) : (
                <ul className="list">
                    {data.issues.map((issue) => (
                        <IssueRow key={issue.id} issue={issue} showChat={showChat} />
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
            {failure === null && !refreshing && data.nextOffset !== null && (
                <button type="button" className="button secondary" disabled={loadingMore} onClick={onLoadMore}>
                    {loadingMore ? '加载中…' : '加载更多'}
                </button>
            )}
        </div>
    );
};
