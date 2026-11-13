import { useMemo } from 'react';
import type { StatsResponse } from '../../api';
import { chatLabelOf } from '../../format';
import { formatBucketLabel, formatCount, formatPercent, formatTokens } from '../../format-metrics';
import { BarChart } from './charts/bar-chart';
import { RankBars } from './charts/rank-bars';
import type { RankRow } from './charts/rank-bars';
import { StackedBarChart } from './charts/stacked-bar-chart';
import { TokenSplitBar } from './charts/token-split-bar';
import type { TokenSegment } from './charts/token-split-bar';
import { platformSeriesOf } from './platform-series';
import { StatsErrors } from './stats-errors';
import { StatsKpis } from './stats-kpis';
import { StatsModelTable } from './stats-model-table';
import { StatsNotes } from './stats-notes';
import { StatsTools } from './stats-tools';

interface StatsViewProps {
    data: StatsResponse;
    // Another range is loading over these rows: dim them instead of flashing a skeleton
    refreshing: boolean;
}

const tokenSegmentsOf = (data: StatsResponse): TokenSegment[] => {
    const { promptTokens, cachedTokens, cacheWriteTokens, outputTokens } = data.kpis;
    return [
        {
            key: 'uncached',
            label: '未缓存输入',
            value: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens),
            colorClass: 'token-uncached',
        },
        { key: 'cached', label: '缓存输入', value: cachedTokens, colorClass: 'token-cached' },
        { key: 'cache-write', label: '缓存写入', value: cacheWriteTokens, colorClass: 'token-write' },
        { key: 'output', label: '输出（含思考）', value: outputTokens, colorClass: 'token-output' },
    ];
};

/** The statistics of one chat or of every chat: same blocks, the all-chats view adds a chat ranking */
export const StatsView = ({ data, refreshing }: StatsViewProps) => {
    const unit = data.bucket;
    const labels = useMemo(
        () => data.series.buckets.map((bucket) => formatBucketLabel(bucket, unit)),
        [data.series.buckets, unit]
    );
    const platformSeries = useMemo(
        () => platformSeriesOf(data.series, data.models),
        [data.series, data.models]
    );
    const errorRateBars = useMemo(
        () =>
            labels.map((label, index) => {
                const replies = data.series.replies[index] ?? 0;
                const errors = data.series.errors[index] ?? 0;
                return { label, value: replies === 0 ? 0 : errors / replies };
            }),
        [labels, data.series.replies, data.series.errors]
    );
    const chatRows = useMemo<RankRow[]>(
        () =>
            (data.chats ?? []).map((row) => ({
                key: String(row.chatId),
                label: chatLabelOf(row),
                value: row.replies,
                detail: `${formatCount(row.errorReplies)} 条错误`,
            })),
        [data.chats]
    );
    const tokenSegments = useMemo(() => tokenSegmentsOf(data), [data]);
    const isAllChats = data.chatId === null;
    const bucketUnit = unit === 'hour' ? '小时' : '天';
    const hasReplies = data.kpis.replies > 0;
    const hasErrors = data.series.errors.some((count) => count > 0);

    return (
        <div className={refreshing ? 'stats-view refreshing' : 'stats-view'}>
            <StatsKpis kpis={data.kpis} cost={data.cost} outcomes={data.outcomes} pricing={data.pricing} />

            <StackedBarChart
                title="回复数"
                hint={hasReplies ? `按${bucketUnit} · 按平台堆叠` : '这个范围里没有回复'}
                buckets={labels}
                series={platformSeries}
                formatValue={formatCount}
                ariaLabel="回复数随时间"
            />

            <BarChart
                title="错误率"
                hint={hasErrors ? `按${bucketUnit} · 错误数 / 回复数` : '这个范围里没有错误'}
                bars={errorRateBars}
                formatValue={formatPercent}
                valueLabel="错误率"
                ariaLabel="错误率随时间"
            />

            {isAllChats && chatRows.length > 0 && (
                <RankBars
                    title="按聊天"
                    hint="这个范围里回复最多的聊天"
                    rows={chatRows}
                    formatValue={formatCount}
                    valueLabel="回复数"
                    ariaLabel="按聊天的回复数"
                />
            )}

            <StatsModelTable rows={data.models} />
            <StatsTools tools={data.tools} kpis={data.kpis} />
            <TokenSplitBar
                title="token"
                hint="只统计上报了用量的回复"
                segments={tokenSegments}
                formatValue={formatTokens}
            />
            <StatsErrors errorKinds={data.errorKinds} recentErrors={data.recentErrors} showChat={isAllChats} />
            <StatsNotes pricing={data.pricing} />
        </div>
    );
};
