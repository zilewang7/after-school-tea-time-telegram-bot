/**
 * Formatting of the numbers the panel shows (durations, ratios, tokens, money,
 * error and outcome labels). One place so the reply detail and the statistics
 * agree on "9.8s" and "2.9%".
 */
import { match } from 'ts-pattern';
import type { ErrorKind, ModelPricingFlag, PricingFlag, ReplyOutcome, ReplyPhase } from './api';

const COUNT_FORMAT = new Intl.NumberFormat('zh-CN');
const RATE_DECIMALS = 1;

export const formatCount = (value: number): string => COUNT_FORMAT.format(value);

/** Dollars, at the precision the amount deserves: $1.84, $0.012, $0.0004 */
export const formatUsd = (value: number | null): string => {
    if (value === null) return '—';
    if (value === 0) return '$0';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
};

/** 0..1 as a percentage; null (nothing to divide by) is a dash */
export const formatPercent = (ratio: number | null, digits = 1): string =>
    ratio === null ? '—' : `${(ratio * 100).toFixed(digits)}%`;

export const formatMs = (ms: number | null): string => {
    if (ms === null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
};

/** How long a live reply has been running: "12s", "1m 5s" */
export const formatElapsed = (ms: number): string => formatMs(Math.max(0, ms));

export const formatTokens = (value: number | null): string => {
    if (value === null) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(value);
};

export const formatBytes = (bytes: number | null): string => {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Streaming speed: characters of output per second */
export const formatCharsPerSecond = (value: number | null): string =>
    value === null ? '—' : `${value.toFixed(RATE_DECIMALS)} 字/秒`;

export const errorKindLabel = (kind: ErrorKind | null): string =>
    match(kind)
        .returnType<string>()
        .with(null, () => '未知')
        .with('rate_limit', () => '限流 429')
        .with('timeout', () => '超时')
        .with('network', () => '网络')
        .with('upstream', () => '上游错误')
        .with('content_filter', () => '内容风控')
        .with('pre_request', () => '请求前失败')
        .with('other', () => '其他')
        .exhaustive();

export const outcomeLabel = (outcome: ReplyOutcome): string =>
    match(outcome)
        .returnType<string>()
        .with('ok', () => '正常')
        .with('error', () => '错误')
        .with('stopped', () => '已停止')
        .with('empty', () => '空回复')
        .exhaustive();

export const pricingLabel = (pricing: PricingFlag | ModelPricingFlag): string =>
    match(pricing)
        .returnType<string>()
        .with('priced', () => '已定价')
        .with('subscription', () => '订阅')
        .with('unpriced', () => '未定价')
        .with('no_usage', () => '无用量')
        .with('partial', () => '部分定价')
        .exhaustive();

export const replyPhaseLabel = (phase: ReplyPhase): string =>
    match(phase)
        .returnType<string>()
        .with('preparing', () => '准备中')
        .with('waiting', () => '等待响应')
        .with('streaming', () => '生成中')
        .exhaustive();

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    grok: 'Grok',
    mimo: 'MiMo',
};

export const platformLabel = (platform: string): string => PLATFORM_LABELS[platform] ?? platform;

/** A bucket label from the statistics: "2026-11-06" → "11-06", "2026-11-06 14:00" → "14:00" */
export const formatBucketLabel = (bucket: string, unit: 'hour' | 'day'): string => {
    if (unit === 'hour') {
        const time = bucket.slice(-5);
        return time;
    }
    return bucket.slice(5);
};
