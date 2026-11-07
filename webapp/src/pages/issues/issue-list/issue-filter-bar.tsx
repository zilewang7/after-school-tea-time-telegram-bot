import { useCallback, useMemo } from 'react';
import type { ChatSummary, IssueKind, IssueStats } from '../../../api';
import { ChoiceChips } from '../../../components/choice-chips';
import type { ChoiceOption } from '../../../components/choice-chips';
import { ISSUE_KIND_OPTIONS } from '../../../issues/issue-labels';
import type { IssueFilters } from './issue-filters';
import { IssueScopeFilters } from './issue-scope-filters';

const KIND_FILTER_OPTIONS: readonly ChoiceOption<IssueKind | null>[] = [
    { value: null, label: '全部类型' },
    ...ISSUE_KIND_OPTIONS,
];

/** 「未关闭 N」/「全部 N」; the counts follow every filter except the status one */
const openOnlyOptionsOf = (stats: IssueStats | null): ChoiceOption<boolean>[] => [
    { value: true, label: stats === null ? '未关闭' : `未关闭 ${stats.byStatus.open}` },
    { value: false, label: stats === null ? '全部' : `全部 ${stats.total}` },
];

interface IssueFilterBarProps {
    filters: IssueFilters;
    // Counts of the rows on screen; null before the first page
    stats: IssueStats | null;
    // The home list also filters by source and chat; null on a chat's tab
    chats: readonly ChatSummary[] | null;
    onChange: (filters: IssueFilters) => void;
}

export const IssueFilterBar = ({ filters, stats, chats, onChange }: IssueFilterBarProps) => {
    const openOnlyOptions = useMemo(() => openOnlyOptionsOf(stats), [stats]);
    const handleOpenOnlyChange = useCallback((openOnly: boolean) => onChange({ ...filters, openOnly }), [filters, onChange]);
    const handleKindChange = useCallback((kind: IssueKind | null) => onChange({ ...filters, kind }), [filters, onChange]);

    return (
        <div className="filter-bar">
            <ChoiceChips label="状态" options={openOnlyOptions} selected={filters.openOnly} onSelect={handleOpenOnlyChange} />
            <ChoiceChips label="类型" options={KIND_FILTER_OPTIONS} selected={filters.kind} onSelect={handleKindChange} />
            {chats !== null && <IssueScopeFilters filters={filters} chats={chats} onChange={onChange} />}
        </div>
    );
};
