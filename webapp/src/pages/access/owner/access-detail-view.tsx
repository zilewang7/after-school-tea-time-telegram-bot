import type { AccessApplicationDetailResponse, AccessApplicationSummary } from '../../../api';
import { FoldableText } from '../../../components/foldable-text';
import { accessStatusBadgeClass, accessStatusLabel } from '../access-labels';
import { AccessDetailActions } from './access-detail-actions';
import { AccessDetailFacts } from './access-detail-facts';
import { AccessHistory } from './access-history';
import { AccessReviewForm } from './access-review-form';

interface AccessDetailViewProps {
    data: AccessApplicationDetailResponse;
    // Whether the applicant currently holds a grant (server truth, then local after a revoke)
    accessActive: boolean;
    onApplicationChanged: (application: AccessApplicationSummary) => void;
    onAccessRevoked: () => void;
    onReload: () => void;
}

/** One application: what was asked, where it came from, the decision, and the applicant's history */
export const AccessDetailView = ({
    data,
    accessActive,
    onApplicationChanged,
    onAccessRevoked,
    onReload,
}: AccessDetailViewProps) => {
    const { application, history } = data;

    return (
        <>
            <header className="page-header">
                <h1>准入申请 #{application.id}</h1>
                <p className="badges">
                    <span className={accessStatusBadgeClass(application.status)}>
                        {accessStatusLabel(application.status)}
                    </span>
                </p>
            </header>
            <AccessDetailFacts application={application} />
            <section className="section">
                <h2 className="section-title">你是谁</h2>
                <FoldableText text={application.identity} />
            </section>
            <section className="section">
                <h2 className="section-title">你要做什么</h2>
                <FoldableText text={application.purpose} />
            </section>
            {application.comment !== null && (
                <section className="section">
                    <h2 className="section-title">机主留言</h2>
                    <p className="prewrap">{application.comment}</p>
                </section>
            )}
            {application.status === 'pending' ? (
                <AccessReviewForm
                    applicationId={application.id}
                    onReviewed={onApplicationChanged}
                    onReload={onReload}
                />
            ) : (
                <AccessDetailActions
                    application={application}
                    accessActive={accessActive}
                    onApplicationChanged={onApplicationChanged}
                    onAccessRevoked={onAccessRevoked}
                    onReload={onReload}
                />
            )}
            <AccessHistory history={history} />
        </>
    );
};
