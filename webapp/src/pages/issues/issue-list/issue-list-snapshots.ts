import type { IssueDetail, IssueStats, IssueSummary } from '../../../api';
import { createSnapshotStore } from '../../../snapshot-store';
import type { IssueFilters } from './issue-filters';

/** Rows on screen, with the filters they were loaded for */
export interface IssueListData {
    filters: IssueFilters;
    issues: IssueSummary[];
    nextOffset: number | null;
    matched: number;
    stats: IssueStats;
}

const SNAPSHOT_CAPACITY = 20;

// One store for both issue lists (home and per chat); the detail and new-issue pages edit it too
const issueListSnapshots = createSnapshotStore<IssueListData>(SNAPSHOT_CAPACITY);

export const readIssueListSnapshot = (key: string): IssueListData | null => issueListSnapshots.read(key);

export const writeIssueListSnapshot = (key: string, data: IssueListData): void => issueListSnapshots.write(key, data);

/** The list row of a loaded issue */
export const summaryOfIssue = (issue: IssueDetail): IssueSummary => ({
    id: issue.id,
    status: issue.status,
    kind: issue.kind,
    severity: issue.severity,
    title: issue.title,
    source: issue.source,
    toolName: issue.toolName,
    chat: issue.chat,
    createdBy: issue.createdBy,
    hasNote: issue.hasNote,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
});

/** Shows an edit made on the detail page in every list that Back may return to */
export const patchIssueInListSnapshots = (issue: IssueSummary): void =>
    issueListSnapshots.updateAll((data) => ({
        ...data,
        issues: data.issues.map((row) => (row.id === issue.id ? issue : row)),
    }));

/** A new issue changes every list; they load fresh the next time they are shown */
export const clearIssueListSnapshots = (): void => issueListSnapshots.clear();
