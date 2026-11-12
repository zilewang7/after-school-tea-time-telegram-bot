import { match } from 'ts-pattern';
import { describeReadFailure } from '../../../api';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { AccessRow } from './access-row';
import type { AccessList } from './use-access-list';

interface AccessListViewProps {
    list: AccessList;
}

/** The review queue's rows with 「加载更多」, or the empty state of the chosen filter */
export const AccessListView = ({ list }: AccessListViewProps) => {
    const { filter, query, loadingMore, loadMoreFailure, loadMore } = list;

    return match(query.state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => <ErrorView failure={failure} onRetry={query.reload} />)
        .with({ status: 'success' }, ({ data }) => (
            <div className="access-list">
                {data.applications.length === 0 ? (
                    <p className="placeholder">{filter === 'pending' ? '没有待审核的申请' : '没有申请'}</p>
                ) : (
                    <ul className="list">
                        {data.applications.map((application) => (
                            <AccessRow key={application.id} application={application} />
                        ))}
                    </ul>
                )}
                {loadMoreFailure !== null && (
                    <div className="save-failure">
                        <p className="error-text">{describeReadFailure(loadMoreFailure)}</p>
                        <button type="button" className="button secondary" onClick={loadMore}>
                            重试
                        </button>
                    </div>
                )}
                {loadMoreFailure === null && data.nextOffset !== null && (
                    <button type="button" className="button secondary" disabled={loadingMore} onClick={loadMore}>
                        {loadingMore ? '加载中…' : '加载更多'}
                    </button>
                )}
            </div>
        ))
        .exhaustive();
};
