import { useMemo } from 'react';
import { Link } from 'react-router';
import type { IssueSummary } from '../../../api';
import { ChatName } from '../../../components/chat-name';
import { formatDate } from '../../../format';
import { issueCreatorLabel, issueKindLabel, issueStatusLabel } from '../../../issues/issue-labels';
import { issuePath } from '../../../routing/paths';

interface IssueRowProps {
    issue: IssueSummary;
    // The home list spans chats, so each row names its chat
    showChat: boolean;
}

/** "#12 title", then "kind · status · who filed it · date" */
export const IssueRow = ({ issue, showChat }: IssueRowProps) => {
    const meta = useMemo(
        () =>
            [
                issueKindLabel(issue.kind),
                issueStatusLabel(issue.status),
                issueCreatorLabel(issue),
                formatDate(issue.createdAt),
            ].join(' · '),
        [issue]
    );

    return (
        <li>
            <Link className="list-link" to={issuePath(issue.id)}>
                <span className="list-title">
                    <span className="issue-title">
                        #{issue.id} {issue.title}
                    </span>
                    <span className="chevron" aria-hidden="true">
                        ›
                    </span>
                </span>
                <span className="hint">{meta}</span>
                {showChat && issue.chat !== null && (
                    <span className="hint truncate">
                        <ChatName chat={issue.chat} />
                    </span>
                )}
            </Link>
        </li>
    );
};
