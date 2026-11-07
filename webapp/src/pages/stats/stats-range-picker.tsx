import { useMemo } from 'react';
import type { StatsRangeKey } from '../../api';
import { ChoiceChips } from '../../components/choice-chips';
import { STATS_RANGES } from './stats-range';

interface StatsRangePickerProps {
    range: StatsRangeKey;
    onChange: (range: StatsRangeKey) => void;
}

/** One row of ranges; switching reloads every block below it */
export const StatsRangePicker = ({ range, onChange }: StatsRangePickerProps) => {
    const options = useMemo(() => STATS_RANGES.map((option) => ({ value: option.key, label: option.label })), []);
    return <ChoiceChips label="时间范围" options={options} selected={range} onSelect={onChange} />;
};
