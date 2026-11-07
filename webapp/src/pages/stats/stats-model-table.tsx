import { useMemo } from 'react';
import type { ModelStatsRow } from '../../api';
import {
    formatCharsPerSecond,
    formatCount,
    formatMs,
    formatPercent,
    formatUsd,
    platformLabel,
    pricingLabel,
} from '../../format-metrics';

interface StatsModelTableProps {
    rows: readonly ModelStatsRow[];
}

interface ModelRowProps {
    row: ModelStatsRow;
}

const ModelRow = ({ row }: ModelRowProps) => {
    const toolLine = useMemo(
        () => `工具 ${formatCount(row.toolCalls)} 次（${formatCount(row.toolFailures)} 失败）`,
        [row.toolCalls, row.toolFailures]
    );
    return (
        <li className="model-stats-row">
            <div className="model-stats-head">
                <span className="truncate">{row.model}</span>
                <span className="model-stats-cost">
                    {formatUsd(row.costUsd)} <span className="hint">{pricingLabel(row.pricing)}</span>
                </span>
            </div>
            <p className="hint">
                {platformLabel(row.platform)} · 回复 {formatCount(row.replies)} · 首字 p50{' '}
                {formatMs(row.firstChunkP50Ms)} · 错误 {formatPercent(row.errorRate)} · 缓存{' '}
                {formatPercent(row.cacheHitRate)}
            </p>
            <p className="hint">
                {toolLine} · 平均轮次 {row.avgRounds === null ? '—' : row.avgRounds.toFixed(1)} · 输出速度{' '}
                {formatCharsPerSecond(row.outputCharsPerSecond)}
            </p>
        </li>
    );
};

/** 「按模型」: a two-line row per model, so seven models do not need a wide table (design §7) */
export const StatsModelTable = ({ rows }: StatsModelTableProps) => (
    <section className="section">
        <h2 className="section-title">按模型</h2>
        {rows.length === 0 ? (
            <p className="hint">这个范围里没有回复</p>
        ) : (
            <ul className="list">
                {rows.map((row) => (
                    <ModelRow key={`${row.model}:${row.platform}`} row={row} />
                ))}
            </ul>
        )}
    </section>
);
