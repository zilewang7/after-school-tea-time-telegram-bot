import { useMemo } from 'react';
import { Link } from 'react-router';
import type { AccessApplicationSummary } from '../../../api';
import { formatDateTime } from '../../../format';
import { accessApplicationPath } from '../../../routing/paths';
import {
    accessApplicantLabel,
    accessSourceChatLabel,
    accessStatusBadgeClass,
    accessStatusLabel,
} from '../access-labels';

interface AccessRowProps {
    application: AccessApplicationSummary;
}

/** Applicant, status, source chat, time and the identity excerpt */
export const AccessRow = ({ application }: AccessRowProps) => {
    const submittedAt = useMemo(() => formatDateTime(application.createdAt), [application.createdAt]);
    const sourceChat = useMemo(() => accessSourceChatLabel(application), [application]);

    return (
        <li>
            <Link className="list-link" to={accessApplicationPath(application.id)}>
                <span className="list-title">
                    <span className="list-title-main">{accessApplicantLabel(application)}</span>
                    <span className="chevron" aria-hidden="true">
                        ›
                    </span>
                </span>
                <span className="badges">
                    <span className={accessStatusBadgeClass(application.status)}>
                        {accessStatusLabel(application.status)}
                    </span>
                    <span className="hint">{submittedAt}</span>
                </span>
                <span className="hint truncate">{sourceChat}</span>
                <span className="hint truncate">{application.identity}</span>
            </Link>
        </li>
    );
};
