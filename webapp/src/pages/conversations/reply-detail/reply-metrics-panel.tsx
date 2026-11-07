import { Fragment, useMemo } from 'react';
import type { ReplyMetric } from '../../../api';
import {
    errorKindLabel,
    formatMs,
    formatPercent,
    formatTokens,
    formatUsd,
    outcomeLabel,
    pricingLabel,
} from '../../../format-metrics';

interface ReplyMetricsPanelProps {
    metrics: ReplyMetric;
}

interface MetricRow {
    label: string;
    value: string;
}

const tokenValueOf = (promptTokens: number | null, cachedTokens: number | null): string => {
    if (promptTokens === null) return '—';
    return cachedTokens === null
        ? formatTokens(promptTokens)
        : `${formatTokens(promptTokens)}（缓存 ${formatTokens(cachedTokens)}）`;
};

const cacheHitRateOf = (metrics: ReplyMetric): number | null => {
    if (metrics.promptTokens === null || metrics.promptTokens <= 0 || metrics.cachedTokens === null) return null;
    return metrics.cachedTokens / metrics.promptTokens;
};

/** One version's reply_metrics: outcome, timings, tokens, context size and the cost estimate */
export const ReplyMetricsPanel = ({ metrics }: ReplyMetricsPanelProps) => {
    const rows = useMemo<MetricRow[]>(() => {
        const list: MetricRow[] = [{ label: '结果', value: outcomeLabel(metrics.outcome) }];
        if (metrics.outcome === 'error') {
            list.push({ label: '错误类型', value: errorKindLabel(metrics.errorKind) });
        }
        list.push(
            { label: '首字', value: formatMs(metrics.firstChunkMs) },
            { label: '总耗时', value: formatMs(metrics.durationMs) },
            { label: '工具轮次', value: metrics.rounds === null ? '—' : String(metrics.rounds) },
            {
                label: '工具调用',
                value: `${metrics.toolCalls} 次${metrics.toolFailures > 0 ? `（${metrics.toolFailures} 次失败）` : ''}`,
            },
            { label: '输入', value: tokenValueOf(metrics.promptTokens, metrics.cachedTokens) },
            { label: '缓存命中', value: formatPercent(cacheHitRateOf(metrics)) },
            {
                label: '输出',
                value:
                    metrics.outputTokens === null
                        ? '—'
                        : `${formatTokens(metrics.outputTokens)}（思考 ${formatTokens(metrics.thoughtsTokens)}）`,
            },
            {
                label: '上下文',
                value: `${metrics.contextMessages ?? '—'} 条消息 · ${metrics.contextImages ?? '—'} 张图`,
            },
            { label: '成本', value: `${formatUsd(metrics.costUsd)}（${pricingLabel(metrics.pricing)}）` }
        );
        return list;
    }, [metrics]);

    return (
        <>
            <dl className="facts">
                {rows.map((row) => (
                    <Fragment key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                    </Fragment>
                ))}
            </dl>
            {metrics.errorSummary !== null && <p className="error-text prewrap">⚠ {metrics.errorSummary}</p>}
        </>
    );
};
