import { useCallback, useState } from 'react';
import { Navigate } from 'react-router';
import { match } from 'ts-pattern';
import { describeAccessApplicationReadFailure } from '../../../api';
import type { AccessApplicationSummary } from '../../../api';
import { ErrorView, LoadingView } from '../../../components/status-views';
import { useMe } from '../../../context/me-context';
import { useApi } from '../../../context/panel-context';
import { useAccessApplicationIdParam } from '../../../hooks/use-access-application-id-param';
import { useApiQuery } from '../../../hooks/use-api-query';
import { ACCESS_PATH } from '../../../routing/paths';
import { NotFoundPage } from '../../not-found-page';
import { AccessDetailView } from './access-detail-view';

interface AccessDetailPageProps {
    applicationId: number;
}

const AccessDetailPage = ({ applicationId }: AccessDetailPageProps) => {
    const api = useApi();
    const { refreshMe } = useMe();
    const loadApplication = useCallback(
        (signal: AbortSignal) => api.getAccessApplication(applicationId, signal),
        [api, applicationId]
    );
    const { state, reload, update } = useApiQuery(loadApplication);
    // Set after a revoke: the application keeps its approved status, the access does not
    const [accessActiveOverride, setAccessActiveOverride] = useState<boolean | null>(null);

    const handleApplicationChanged = useCallback(
        (application: AccessApplicationSummary) => {
            update((data) => ({ ...data, application }));
            // The review queue's badge follows the pending count
            refreshMe();
        },
        [update, refreshMe]
    );

    const handleAccessRevoked = useCallback(() => setAccessActiveOverride(false), []);

    return match(state)
        .with({ status: 'loading' }, () => <LoadingView />)
        .with({ status: 'error' }, ({ failure }) => (
            <ErrorView failure={failure} message={describeAccessApplicationReadFailure(failure)} onRetry={reload} />
        ))
        .with({ status: 'success' }, ({ data }) => (
            <AccessDetailView
                data={data}
                // A revoke just made: the button goes away without a refetch
                accessActive={accessActiveOverride ?? data.accessActive}
                onApplicationChanged={handleApplicationChanged}
                onAccessRevoked={handleAccessRevoked}
                onReload={reload}
            />
        ))
        .exhaustive();
};

/** /access/:applicationId: one application's review page (owner only) */
export const AccessDetailRoute = () => {
    const { me } = useMe();
    const applicationId = useAccessApplicationIdParam();
    // The review API is owner only; a non-owner reaching the URL goes to the tab
    if (!me.isOwner) return <Navigate replace to={ACCESS_PATH} />;
    if (applicationId === null) return <NotFoundPage />;
    // Keyed so moving between applications starts from a clean state
    return <AccessDetailPage key={applicationId} applicationId={applicationId} />;
};
