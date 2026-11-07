import { useCallback, useMemo, useState } from 'react';
import { ChartCard } from './chart-card';
import { ChartTable } from './chart-table';
import type { ChartTableRow } from './chart-table';
import { useElementWidth } from './use-element-width';

const PLOT_HEIGHT = 120;
const AXIS_HEIGHT = 16;
const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;
const CORNER_RADIUS = 4;
const MAX_X_LABELS = 8;

export interface BarDatum {
    label: string;
    value: number;
}

interface BarChartProps {
    title: string;
    hint?: string | null;
    bars: readonly BarDatum[];
    // Value formatting for the tooltip and the table
    formatValue: (value: number) => string;
    // Header of the table's value column
    valueLabel: string;
    ariaLabel: string;
    // Series colour class from styles.css, e.g. `series-gemini`
    colorClass?: string;
}

/** Rounded top, square bottom (design §7) */
const barPathOf = (x: number, y: number, width: number, height: number): string => {
    const radius = Math.min(CORNER_RADIUS, width / 2, height);
    const top = y;
    const bottom = y + height;
    return [
        `M ${x} ${bottom}`,
        `V ${top + radius}`,
        `Q ${x} ${top} ${x + radius} ${top}`,
        `H ${x + width - radius}`,
        `Q ${x + width} ${top} ${x + width} ${top + radius}`,
        `V ${bottom}`,
        'Z',
    ].join(' ');
};

/** The first and last labels are anchored inward so they are not clipped by the plot edge */
const axisLabelAnchorOf = (index: number, count: number): 'start' | 'middle' | 'end' =>
    index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';

const axisLabelXOf = (index: number, count: number, slot: number, width: number): number => {
    if (index === 0) return 2;
    if (index === count - 1) return width - 2;
    return index * slot + slot / 2;
};

/** Every n-th label, so 24 hourly buckets do not print 24 overlapping labels */
const labelIndexesOf = (count: number): ReadonlySet<number> => {
    if (count <= MAX_X_LABELS) return new Set(Array.from({ length: count }, (_, index) => index));
    const step = Math.ceil(count / MAX_X_LABELS);
    const indexes = new Set<number>();
    for (let index = 0; index < count; index += step) indexes.add(index);
    indexes.add(count - 1);
    return indexes;
};

/** One series as vertical bars; tap a bar for its exact value (design §7: no hover on phones) */
export const BarChart = ({
    title,
    hint = null,
    bars,
    formatValue,
    valueLabel,
    ariaLabel,
    colorClass = 'series-neutral',
}: BarChartProps) => {
    const [containerRef, width] = useElementWidth();
    const [selected, setSelected] = useState<number | null>(null);
    const labelIndexes = useMemo(() => labelIndexesOf(bars.length), [bars.length]);
    const maxValue = useMemo(() => Math.max(...bars.map((bar) => bar.value), 1), [bars]);
    const handleSelect = useCallback(
        (index: number) => setSelected((current) => (current === index ? null : index)),
        []
    );

    const tableRows = useMemo<ChartTableRow[]>(
        () => bars.map((bar) => ({ key: bar.label, cells: [bar.label, formatValue(bar.value)] })),
        [bars, formatValue]
    );

    const plot = useMemo(() => {
        if (bars.length === 0) return <p className="hint">没有数据</p>;
        if (width <= 0) return null;
        const slot = width / bars.length;
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
                {bars.map((bar, index) => {
                    const height = (bar.value / maxValue) * plotHeight;
                    const x = index * slot + (slot - barWidth) / 2;
                    const y = plotHeight - height;
                    return (
                        <g key={bar.label}>
                            <path className={`chart-bar ${colorClass}`} d={barPathOf(x, y, barWidth, height)} />
                            <rect
                                className="chart-hit"
                                x={index * slot}
                                y={0}
                                width={slot}
                                height={plotHeight}
                                onClick={() => handleSelect(index)}
                            />
                            {labelIndexes.has(index) && (
                                <text
                                    className="chart-axis-label"
                                    x={axisLabelXOf(index, bars.length, slot, width)}
                                    y={PLOT_HEIGHT - 4}
                                    textAnchor={axisLabelAnchorOf(index, bars.length)}
                                >
                                    {bar.label}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        );
    }, [bars, width, ariaLabel, maxValue, labelIndexes, colorClass, handleSelect]);

    const selectedBar = selected === null ? null : (bars[selected] ?? null);
    const chart = (
        <div className="chart-plot" ref={containerRef}>
            {plot}
            {selectedBar !== null && (
                <div
                    className="chart-tooltip"
                    style={{ left: `${(((selected ?? 0) + 0.5) / Math.max(bars.length, 1)) * 100}%` }}
                >
                    <strong>{formatValue(selectedBar.value)}</strong> {selectedBar.label}
                </div>
            )}
        </div>
    );

    return (
        <ChartCard
            title={title}
            hint={hint}
            chart={chart}
            table={<ChartTable columns={['时间', valueLabel]} rows={tableRows} />}
        />
    );
};
