import { useMemo } from 'react';
import { ChartCard } from './chart-card';
import { ChartTable } from './chart-table';
import type { ChartTableRow } from './chart-table';

export interface RankRow {
    key: string;
    label: string;
    value: number;
    // e.g. "失败 2%" or "12 次回复"
    detail: string | null;
}

interface RankBarsProps {
    title: string;
    hint?: string | null;
    rows: readonly RankRow[];
    formatValue: (value: number) => string;
    valueLabel: string;
    ariaLabel: string;
}

/** A ranked horizontal bar list: one colour, the value written after each bar (design §7) */
export const RankBars = ({ title, hint = null, rows, formatValue, valueLabel, ariaLabel }: RankBarsProps) => {
    const maxValue = useMemo(() => Math.max(...rows.map((row) => row.value), 1), [rows]);
    const tableRows = useMemo<ChartTableRow[]>(
        () => rows.map((row) => ({ key: row.key, cells: [row.label, formatValue(row.value)] })),
        [rows, formatValue]
    );

    const chart =
        rows.length === 0 ? (
            <p className="hint">没有数据</p>
        ) : (
            <ul className="rank-list" aria-label={ariaLabel}>
                {rows.map((row) => (
                    <li key={row.key} className="rank-row">
                        <span className="rank-label truncate">{row.label}</span>
                        <span className="rank-track">
                            <span
                                className="rank-bar"
                                style={{ width: `${Math.max(1, (row.value / maxValue) * 100)}%` }}
                            />
                        </span>
                        <span className="rank-value">{formatValue(row.value)}</span>
                        {row.detail !== null && <span className="rank-detail hint">{row.detail}</span>}
                    </li>
                ))}
            </ul>
        );

    return (
        <ChartCard
            title={title}
            hint={hint}
            chart={chart}
            table={<ChartTable columns={['名称', valueLabel]} rows={tableRows} />}
        />
    );
};
