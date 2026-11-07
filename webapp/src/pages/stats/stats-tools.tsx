import { useMemo } from 'react';
import type { StatsKpis, ToolStatsRow } from '../../api';
import { formatCount, formatPercent } from '../../format-metrics';
import { RankBars } from './charts/rank-bars';
import type { RankRow } from './charts/rank-bars';

interface StatsToolsProps {
    tools: readonly ToolStatsRow[];
    kpis: StatsKpis;
}

/** Tool calls and their failure rate, most called first */
export const StatsTools = ({ tools, kpis }: StatsToolsProps) => {
    const rows = useMemo<RankRow[]>(
        () =>
            tools.map((tool) => ({
                key: tool.name,
                label: tool.name,
                value: tool.calls,
                detail: `${formatCount(tool.replies)} 条回复 · 失败 ${formatPercent(tool.failureRate)}`,
            })),
        [tools]
    );
    const hint = `平均每回复 ${kpis.avgToolCalls === null ? '—' : kpis.avgToolCalls.toFixed(1)} 次调用 · 平均 ${
        kpis.avgRounds === null ? '—' : kpis.avgRounds.toFixed(1)
    } 轮 · 失败率 ${formatPercent(kpis.toolFailureRate)}`;

    return <RankBars title="工具" hint={hint} rows={rows} formatValue={formatCount} valueLabel="调用次数" ariaLabel="工具调用次数" />;
};
