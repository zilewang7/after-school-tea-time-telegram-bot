import { Link } from 'react-router';
import { useChatScope } from '../../../context/chat-scope-context';
import { useMe } from '../../../context/me-context';
import { chatIssueNewPath } from '../../../routing/paths';
import { IssueFilterBar } from './issue-filter-bar';
import { IssueListView } from './issue-list-view';
import { useIssueList } from './use-issue-list';

/** /c/:chatId/issues: this chat's issues, and the way to file one */
export const ChatIssuesTab = () => {
    const { chatId } = useChatScope();
    const { state, setFilters, loadMore, retry } = useIssueList(chatId);

    return (
        <section className="section">
            <div className="filter-bar-with-action">
                <IssueFilterBar filters={state.filters} stats={state.data?.stats ?? null} chats={null} onChange={setFilters} />
                {/* A plain link: the MainButton is reserved for submitting the form */}
                <Link className="link-action" to={chatIssueNewPath(chatId)}>
                    提 issue
                </Link>
            </div>
            <IssueListView state={state} showChat={false} onLoadMore={loadMore} onRetry={retry} />
        </section>
    );
};

/** /issues: every issue this user may see, across chats */
export const HomeIssuesTab = () => {
    const { me } = useMe();
    const { state, setFilters, loadMore, retry } = useIssueList(null);

    return (
        <section className="section">
            <IssueFilterBar filters={state.filters} stats={state.data?.stats ?? null} chats={me.chats} onChange={setFilters} />
            <IssueListView state={state} showChat onLoadMore={loadMore} onRetry={retry} />
        </section>
    );
};
