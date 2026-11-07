import { useCallback, useMemo, useState } from 'react';
import { ChartCard } from './chart-card';
import { ChartTable } from './chart-table';
import type { ChartTableRow } from './chart-table';
import { useElementWidth } from './use-element-width';

const PLOT_HEIGHT = 120;
const AXIS_HEIGHT = 16;
const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;
const SEGMENT_GAP = 2;
const MAX_X_LABELS = 8;

export interface StackedSeries {
    key: string;
    label: string;
    values: readonly number[];
    // Series colour class from styles.css, e.g. `series-gemini`
    colorClass: string;
}

interface StackedBarChartProps {
    title: string;
    hint?: string | null;
    // Local bucket labels, one per bar
    buckets: readonly string[];
    series: readonly StackedSeries[];
    formatValue: (value: number) => string;
    ariaLabel: string;
}

/** The first and last labels are anchored inward so they are not clipped by the plot edge */
const axisLabelAnchorOf = (index: number, count: number): 'start' | 'middle' | 'end' =>
    index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';

const axisLabelXOf = (index: number, count: number, slot: number, width: number): number => {
    if (index === 0) return 2;
    if (index === count - 1) return width - 2;
    return index * slot + slot / 2;
};

const labelIndexesOf = (count: number): ReadonlySet<number> => {
    if (count <= MAX_X_LABELS) return new Set(Array.from({ length: count }, (_, index) => index));
    const step = Math.ceil(count / MAX_X_LABELS);
    const indexes = new Set<number>();
    for (let index = 0; index < count; index += step) indexes.add(index);
    indexes.add(count - 1);
    return indexes;
};

/** Replies per platform over time as stacked bars, with a legend and the same numbers as a table */
export const StackedBarChart = ({
    title,
    hint = null,
    buckets,
    series,
    formatValue,
    ariaLabel,
}: StackedBarChartProps) => {
    const [containerRef, width] = useElementWidth();
    const [selected, setSelected] = useState<number | null>(null);
    const labelIndexes = useMemo(() => labelIndexesOf(buckets.length), [buckets.length]);
    const totals = useMemo(
        () =>
            buckets.map((_, bucketIndex) =>
                series.reduce((total, line) => total + (line.values[bucketIndex] ?? 0), 0)
            ),
        [buckets, series]
    );
    const maxTotal = useMemo(() => Math.max(...totals, 1), [totals]);
    const handleSelect = useCallback(
        (index: number) => setSelected((current) => (current === index ? null : index)),
        []
    );

    const tableRows = useMemo<ChartTableRow[]>(
        () =>
            buckets.map((bucket, bucketIndex) => ({
                key: bucket,
                cells: [
                    bucket,
                    ...series.map((line) => formatValue(line.values[bucketIndex] ?? 0)),
                    formatValue(totals[bucketIndex] ?? 0),
                ],
            })),
        [buckets, series, totals, formatValue]
    );

    const plot = useMemo(() => {
        if (buckets.length === 0) return <p className="hint">没有数据</p>;
        if (width <= 0) return null;
        const slot = width / buckets.length;
        const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(2, slot - BAR_GAP));
        const plotHeight = PLOT_HEIGHT - AXIS_HEIGHT;
        return (
            <svg width={width} height={PLOT_HEIGHT} role="img" aria-label={ariaLabel} className="chart-svg">
                {[0, 0.5, 1].map((fraction) => (
                    <line
                        key={fraction}
                        className="chart-grid"
                        x1={0}
                        x2={width}
                        y1={plotHeight - fraction * plotHeight}
                        y2={plotHeight - fraction * plotHeight}
                    />
                ))}
                {buckets.map((bucket, bucketIndex) => {
                    const x = bucketIndex * slot + (slot - barWidth) / 2;
                    let bottom = plotHeight;
                    const segments = series.map((line) => {
                        const value = line.values[bucketIndex] ?? 0;
                        const height = (value / maxTotal) * plotHeight;
                        const segment = { key: line.key, colorClass: line.colorClass, y: bottom - height, height };
                        bottom -= height + (height > 0 ? SEGMENT_GAP : 0);
                        return segment;
                    });
                    return (
                        <g key={bucket}>
                            {segments.map((segment) =>
                                segment.height <= 0 ? null : (
                                    <rect
                                        key={segment.key}
                                        className={`chart-segment ${segment.colorClass}`}
                                        x={x}
                                        y={segment.y}
                                        width={barWidth}
                                        height={Math.max(1, segment.height - SEGMENT_GAP)}
                                    />
                                )
                            )}
                            <rect
                                className="chart-hit"
                                x={bucketIndex * slot}
                                y={0}
                                width={slot}
                                height={plotHeight}
                                onClick={() => handleSelect(bucketIndex)}
                            />
                            {labelIndexes.has(bucketIndex) && (
                                <text
                                    className="chart-axis-label"
                                    x={axisLabelXOf(bucketIndex, buckets.length, slot, width)}
                                    y={PLOT_HEIGHT - 4}
                                    textAnchor={axisLabelAnchorOf(bucketIndex, buckets.length)}
                                >
                                    {bucket}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        );
    }, [buckets, series, width, maxTotal, ariaLabel, labelIndexes, handleSelect]);

    const selectedBucket = selected === null ? null : buckets[selected];
    const chart = (
        <>
            <div className="chart-plot" ref={containerRef}>
                {plot}
                {selectedBucket !== undefined && selectedBucket !== null && (
                    <div
                        className="chart-tooltip chart-tooltip-wide"
                        style={{ left: `${(((selected ?? 0) + 0.5) / Math.max(buckets.length, 1)) * 100}%` }}
                    >
                        <p className="chart-tooltip-title">{selectedBucket}</p>
                        {series.map((line) => (
                            <p key={line.key} className="chart-tooltip-line">
                                <span className={`legend-dot ${line.colorClass}`} aria-hidden="true" />
                                {formatValue(line.values[selected ?? 0] ?? 0)} {line.label}
                            </p>
                        ))}
                    </div>
                )}
            </div>
            <ul className="chart-legend">
                {series.map((line) => (
                    <li key={line.key}>
                        <span className={`legend-dot ${line.colorClass}`} aria-hidden="true" />
                        {line.label}
                    </li>
                ))}
            </ul>
        </>
    );

    return (
        <ChartCard
            title={title}
            hint={hint}
            chart={chart}
            table={
                <ChartTable
                    columns={['时间', ...series.map((line) => line.label), '合计']}
                    rows={tableRows}
                />
            }
        />
    );
};
