import { useCallback, useMemo } from 'react';
import type { AccessApplicationsResponse } from '../../../api';
import { ChoiceChips } from '../../../components/choice-chips';
import type { ChoiceOption } from '../../../components/choice-chips';
import type { AccessStatusFilter } from './use-access-list';

interface AccessFilterBarProps {
    filter: AccessStatusFilter;
    // The page on screen; null before the first page
    data: AccessApplicationsResponse | null;
    onChange: (filter: AccessStatusFilter) => void;
}

/** 「待审核 N」/「全部」; the total is only known once the 全部 list is loaded */
export const AccessFilterBar = ({ filter, data, onChange }: AccessFilterBarProps) => {
    const options = useMemo<readonly ChoiceOption<AccessStatusFilter>[]>(
        () => [
            { value: 'pending', label: data === null ? '待审核' : `待审核 ${data.stats.pending}` },
            {
                value: 'all',
                label: data === null || filter === 'pending' ? '全部' : `全部 ${data.matched}`,
            },
        ],
        [data, filter]
    );
    const handleSelect = useCallback((value: AccessStatusFilter) => onChange(value), [onChange]);

    return <ChoiceChips label="状态" options={options} selected={filter} onSelect={handleSelect} />;
};
