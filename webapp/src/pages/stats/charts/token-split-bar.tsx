import { useMemo } from 'react';
import { ChartCard } from './chart-card';
import { ChartTable } from './chart-table';
import type { ChartTableRow } from './chart-table';

export interface TokenSegment {
    key: string;
    label: string;
    value: number;
    // Segment colour class from styles.css, e.g. `series-gemini`
    colorClass: string;
}

interface TokenSplitBarProps {
    title: string;
    hint?: string | null;
    segments: readonly TokenSegment[];
    formatValue: (value: number) => string;
}

/** A single segmented bar (uncached / cached / output) with the numbers beside it */
export const TokenSplitBar = ({ title, hint = null, segments, formatValue }: TokenSplitBarProps) => {
    const total = useMemo(() => segments.reduce((sum, segment) => sum + segment.value, 0), [segments]);
    const tableRows = useMemo<ChartTableRow[]>(
        () => segments.map((segment) => ({ key: segment.key, cells: [segment.label, formatValue(segment.value)] })),
        [segments, formatValue]
    );

    const chart =
        total === 0 ? (
            <p className="hint">没有数据</p>
        ) : (
            <>
                <div className="token-bar" role="img" aria-label="token 构成">
                    {segments.map((segment) =>
                        segment.value <= 0 ? null : (
                            <span
                                key={segment.key}
                                className={`token-segment ${segment.colorClass}`}
                                style={{ width: `${(segment.value / total) * 100}%` }}
                            />
                        )
                    )}
                </div>
                <ul className="chart-legend">
                    {segments.map((segment) => (
                        <li key={segment.key}>
                            <span className={`legend-dot ${segment.colorClass}`} aria-hidden="true" />
                            {segment.label} {formatValue(segment.value)}
                        </li>
                    ))}
                </ul>
            </>
        );

    return <ChartCard title={title} hint={hint} chart={chart} table={<ChartTable columns={['项目', '数量']} rows={tableRows} />} />;
};
