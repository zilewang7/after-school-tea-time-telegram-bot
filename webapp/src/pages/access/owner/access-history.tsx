import { Link } from 'react-router';
import type { AccessApplicationSummary } from '../../../api';
import { formatDateTime } from '../../../format';
import { accessApplicationPath } from '../../../routing/paths';
import { accessStatusBadgeClass, accessStatusLabel } from '../access-labels';

interface AccessHistoryProps {
    history: readonly AccessApplicationSummary[];
}

/** The same applicant's other applications; nothing when this is the only one */
export const AccessHistory = ({ history }: AccessHistoryProps) => {
    if (history.length === 0) return null;
    return (
        <section className="section">
            <h2 className="section-title">同一申请人的其他申请</h2>
            <ul className="list">
                {history.map((entry) => (
                    <li key={entry.id}>
                        <Link className="list-link" to={accessApplicationPath(entry.id)}>
                            <span className="list-title">
                                <span className="list-title-main">
                                    #{entry.id} {formatDateTime(entry.createdAt)}
                                </span>
                                <span className="chevron" aria-hidden="true">
                                    ›
                                </span>
                            </span>
                            <span className="badges">
                                <span className={accessStatusBadgeClass(entry.status)}>
                                    {accessStatusLabel(entry.status)}
                                </span>
                            </span>
                            {entry.comment !== null && <span className="hint truncate">留言：{entry.comment}</span>}
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
};
