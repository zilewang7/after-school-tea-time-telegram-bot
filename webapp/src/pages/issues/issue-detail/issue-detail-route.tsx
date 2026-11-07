import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import { describeIssueReadFailure } from '../../../api';
import type { IssueDetail } from '../../../api';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { useMe } from '../../../context/me-context';
import { useApi } from '../../../context/panel-context';
import { useApiQuery } from '../../../hooks/use-api-query';
import { useIssueIdParam } from '../../../hooks/use-issue-id-param';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';
import { NotFoundPage } from '../../not-found-page';
import { patchIssueInListSnapshots, summaryOfIssue } from '../issue-list/issue-list-snapshots';
import { IssueDetailView } from './issue-detail-view';

interface IssueDetailPageProps {
    issueId: number;
}

const IssueDetailPage = ({ issueId }: IssueDetailPageProps) => {
    const api = useApi();
    const { me, refreshMe } = useMe();
    const loadIssue = useCallback((signal: AbortSignal) => api.getIssue(issueId, signal), [api, issueId]);
    const { state, reload, update } = useApiQuery(loadIssue);
    const [justSaved, setJustSaved] = useState(false);
    const notifySaved = useSuccessHaptic();

    const handleSaved = useCallback(
        (issue: IssueDetail) => {
            update(() => ({ issue }));
            setJustSaved(true);
            notifySaved();
            // The list Back returns to shows the new status right away
            patchIssueInListSnapshots(summaryOfIssue(issue));
            // Open counts on the tab badges and the chat list
            refreshMe();
        },
        [update, notifySaved, refreshMe]
    );

    const handleReload = useCallback(() => {
        setJustSaved(false);
        reload();
    }, [reload]);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => (
            <ErrorView failure={failure} message={describeIssueReadFailure(failure)} onRetry={handleReload} />
        ))
        .with({ status: 'success' }, ({ data }) => (
            <IssueDetailView
                issue={data.issue}
                isOwner={me.isOwner}
                justSaved={justSaved}
                onSaved={handleSaved}
                onReload={handleReload}
            />
        ))
        .exhaustive();
};

/** /issues/:issueId, reached from a list or straight from a group notice (start_param i<id>) */
export const IssueDetailRoute = () => {
    const issueId = useIssueIdParam();
    if (issueId === null) return <NotFoundPage />;
    // Keyed so moving between issues starts from a clean state
    return <IssueDetailPage key={issueId} issueId={issueId} />;
};
