import { match } from 'ts-pattern';
import type { IssueDetail } from '../../../api';
import { issueKindLabel, issueSeverityLabel, issueStatusLabel, parseIssueStatus } from '../../../issues/issue-labels';
import { IssueBody } from './issue-body';
import { IssueFacts } from './issue-facts';
import { IssueTriageForm } from './issue-triage-form';

const statusBadgeClassOf = (status: string): string =>
    match(parseIssueStatus(status))
        .with('open', () => 'badge warning')
        .with('fixed', () => 'badge success')
        .otherwise(() => 'badge');

interface IssueNoteProps {
    note: string;
}

const IssueNote = ({ note }: IssueNoteProps) => (
    <section className="section">
        <h2 className="section-title">处理备注</h2>
        <p className="prewrap">{note}</p>
    </section>
);

interface IssueDetailViewProps {
    issue: IssueDetail;
    isOwner: boolean;
    justSaved: boolean;
    onSaved: (issue: IssueDetail) => void;
    onReload: () => void;
}

export const IssueDetailView = ({ issue, isOwner, justSaved, onSaved, onReload }: IssueDetailViewProps) => (
    <>
        <header className="page-header">
            <h1>
                #{issue.id} {issue.title}
            </h1>
            <p className="badges">
                <span className={statusBadgeClassOf(issue.status)}>{issueStatusLabel(issue.status)}</span>
                <span className="badge">{issueKindLabel(issue.kind)}</span>
                {issue.severity !== null && <span className="badge">严重程度 {issueSeverityLabel(issue.severity)}</span>}
            </p>
        </header>
        <IssueFacts issue={issue} />
        <section className="section">
            <h2 className="section-title">正文</h2>
            <IssueBody text={issue.body} />
        </section>
        {isOwner ? (
            <IssueTriageForm
                // Re-created from server state after every save
                key={issue.updatedAt}
                issue={issue}
                justSaved={justSaved}
                onSaved={onSaved}
                onReload={onReload}
            />
        ) : (
            issue.note !== null && <IssueNote note={issue.note} />
        )}
    </>
);
