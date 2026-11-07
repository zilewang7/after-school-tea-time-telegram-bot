// Issue vocabulary: the known values and how the panel names them.

import type { IssueKind, IssueSeverity, IssueSource, IssueStatus, IssueSummary } from '../api';

export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'improvement', 'feature'];
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['low', 'medium', 'high'];
export const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'triaged', 'fixed', 'wontfix', 'duplicate'];
export const ISSUE_SOURCES: readonly IssueSource[] = ['model', 'user'];

const KIND_LABELS: Record<IssueKind, string> = { bug: 'bug', improvement: '改进', feature: '新功能' };
const SEVERITY_LABELS: Record<IssueSeverity, string> = { low: '低', medium: '中', high: '高' };
const STATUS_LABELS: Record<IssueStatus, string> = {
    open: '未处理',
    triaged: '已确认',
    fixed: '已修复',
    wontfix: '不修复',
    duplicate: '重复',
};
const SOURCE_LABELS: Record<IssueSource, string> = { model: '模型提交', user: '用户提交' };

export const parseIssueKind = (raw: string): IssueKind | null => ISSUE_KINDS.find((kind) => kind === raw) ?? null;

export const parseIssueSeverity = (raw: string): IssueSeverity | null =>
    ISSUE_SEVERITIES.find((severity) => severity === raw) ?? null;

export const parseIssueStatus = (raw: string): IssueStatus | null =>
    ISSUE_STATUSES.find((status) => status === raw) ?? null;

export const parseIssueSource = (raw: string): IssueSource | null =>
    ISSUE_SOURCES.find((source) => source === raw) ?? null;

// A value this build does not know (a newer server) is shown as it is

export const issueKindLabel = (kind: string): string => {
    const known = parseIssueKind(kind);
    return known === null ? kind : KIND_LABELS[known];
};

export const issueSeverityLabel = (severity: string): string => {
    const known = parseIssueSeverity(severity);
    return known === null ? severity : SEVERITY_LABELS[known];
};

export const issueStatusLabel = (status: string): string => {
    const known = parseIssueStatus(status);
    return known === null ? status : STATUS_LABELS[known];
};

export const issueSourceLabel = (source: IssueSource): string => SOURCE_LABELS[source];

/** Who filed it: the person's name, or 「模型提交」 */
export const issueCreatorLabel = (issue: IssueSummary): string =>
    issue.source === 'model' ? SOURCE_LABELS.model : (issue.createdBy?.name ?? SOURCE_LABELS.user);

export interface LabeledValue<TValue> {
    value: TValue;
    label: string;
}

export const ISSUE_KIND_OPTIONS: readonly LabeledValue<IssueKind>[] = ISSUE_KINDS.map((kind) => ({
    value: kind,
    label: KIND_LABELS[kind],
}));

export const ISSUE_SEVERITY_OPTIONS: readonly LabeledValue<IssueSeverity>[] = ISSUE_SEVERITIES.map((severity) => ({
    value: severity,
    label: SEVERITY_LABELS[severity],
}));

export const ISSUE_STATUS_OPTIONS: readonly LabeledValue<IssueStatus>[] = ISSUE_STATUSES.map((status) => ({
    value: status,
    label: STATUS_LABELS[status],
}));

export const ISSUE_SOURCE_OPTIONS: readonly LabeledValue<IssueSource>[] = ISSUE_SOURCES.map((source) => ({
    value: source,
    label: SOURCE_LABELS[source],
}));
