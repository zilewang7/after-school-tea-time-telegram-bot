import { useCallback, useState } from 'react';
import type { AccessApplicationSelf, AccessApplicationSummary } from '../../../api';
import { useMe } from '../../../context/me-context';
import { AccessApplicationForm } from './access-application-form';
import { AccessStatusCard } from './access-status-card';

const selfOfCreated = (application: AccessApplicationSummary): AccessApplicationSelf => ({
    id: application.id,
    status: application.status,
    comment: application.comment,
    createdAt: application.createdAt,
});

/** /access for a trial user: the current status and, unless a review is pending, the form */
export const TrialAccessTab = () => {
    const { me, refreshMe } = useMe();
    // Set from the create response, so the pending card shows before /api/me is back
    const [submitted, setSubmitted] = useState<AccessApplicationSelf | null>(null);
    const application = submitted ?? me.accessApplication;
    // accessTier is authoritative: a trial user whose latest application reads
    // 'approved' had the grant revoked, so they may apply again
    const canApply = application === null || application.status !== 'pending';

    const handleCreated = useCallback(
        (created: AccessApplicationSummary) => {
            setSubmitted(selfOfCreated(created));
            refreshMe();
        },
        [refreshMe]
    );

    return (
        <>
            <AccessStatusCard application={application} trialModel={me.trialModel} />
            {canApply && <AccessApplicationForm onCreated={handleCreated} />}
        </>
    );
};
