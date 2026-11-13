import { useMemo } from 'react';
import type { OutcomeCounts, PricingMeta, StatsKpis as StatsKpisData } from '../../api';
import { formatCount, formatMs, formatPercent, formatPriceTableVersion, formatUsd } from '../../format-metrics';

interface KpiCard {
    key: string;
    label: string;
    value: string;
    // Second line: the context of the number
    detail: string;
}

const outcomeSummaryOf = (outcomes: OutcomeCounts): string =>
    [
        `正常 ${formatCount(outcomes.ok)}`,
        `错误 ${formatCount(outcomes.error)}`,
        `停止 ${formatCount(outcomes.stopped)}`,
        `空回复 ${formatCount(outcomes.empty)}`,
    ].join(' · ');

interface StatsKpisProps {
    kpis: StatsKpisData;
    cost: { costUsd: number | null; pricedReplyRatio: number | null };
    outcomes: OutcomeCounts;
    pricing: PricingMeta;
}

/** The 2×2 number cards on top of the statistics (design §7) */
export const StatsKpis = ({ kpis, cost, outcomes, pricing }: StatsKpisProps) => {
    const cards = useMemo<KpiCard[]>(
        () => [
            {
                key: 'replies',
                label: '回复',
                value: formatCount(kpis.replies),
                detail: `重试占比 ${formatPercent(kpis.retryRatio)} · 触发用户 ${formatCount(kpis.triggerUsers)}`,
            },
            {
                key: 'errors',
                label: '错误率',
                value: formatPercent(kpis.errorRate),
                detail: `${formatCount(kpis.errorReplies)} 条错误 · ${outcomeSummaryOf(outcomes)}`,
            },
            {
                key: 'first-chunk',
                label: '首字 p50',
                value: formatMs(kpis.firstChunkP50Ms),
                detail: `p95 ${formatMs(kpis.firstChunkP95Ms)} · 总耗时 p50 ${formatMs(kpis.durationP50Ms)}`,
            },
            {
                key: 'cost',
                label: '估算费用',
                value: formatUsd(cost.costUsd),
                detail: `已定价 ${formatPercent(cost.pricedReplyRatio)} · 按官方标价估算 · 价格表 ${formatPriceTableVersion(pricing.version)}`,
            },
        ],
        [kpis, cost, outcomes, pricing]
    );

    return (
        <section className="kpi-grid" aria-label="关键指标">
            {cards.map((card) => (
                <div key={card.key} className="kpi-card">
                    <p className="kpi-label">{card.label}</p>
                    <p className="kpi-value">{card.value}</p>
                    <p className="hint">{card.detail}</p>
                </div>
            ))}
        </section>
    );
};
