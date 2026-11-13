/**
 * Formatting of the numbers the panel shows (durations, ratios, tokens, money,
 * error and outcome labels). One place so the reply detail and the statistics
 * agree on "9.8s" and "2.9%".
 */
import { match } from 'ts-pattern';
import type {
    ErrorKind,
    ModelPricingFlag,
    PricingFlag,
    PriorityHitCounts,
    ReplyMetric,
    ReplyOutcome,
    ReplyPhase,
} from './api';
import { THINKING_EFFORT_OFF_LABEL, thinkingEffortAuditValue, thinkingEffortLabel } from './thinking-effort';

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

/** The price table's version label; 'seed' is the built-in table before the DB loads */
export const formatPriceTableVersion = (version: string): string => (version === 'seed' ? '内置' : version);

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

/** The pricing label, noting priority rounds priced at the standard price (the model has no priority price) */
export const pricingNoteOf = (pricing: PricingFlag | ModelPricingFlag, priorityAtStandardPrice: boolean): string =>
    priorityAtStandardPrice ? `${pricingLabel(pricing)} · Priority 轮按标准价估算` : pricingLabel(pricing);

/** 「Priority 命中 1 / 6 轮（16.7%）」 over the replies that asked; null when none asked */
export const priorityHitTextOf = (counts: PriorityHitCounts): string | null =>
    counts.priorityReplies === 0
        ? null
        : `Priority 命中 ${formatCount(counts.priorityHitRounds)} / ${formatCount(counts.priorityRequestedRounds)} 轮（${formatPercent(counts.priorityHitRate)}）`;

/** Priority rounds of replies that never asked for the tier, kept out of the hit rate; null when none */
export const strayPriorityTextOf = (counts: PriorityHitCounts): string | null =>
    counts.strayPriorityRounds === 0
        ? null
        : `未请求 Priority 却按优先档服务 ${formatCount(counts.strayPriorityRounds)} 轮`;

/** The thinking-effort columns of one reply metric; a view without them is fine too */
export type ThinkingEffortFields = Pick<
    ReplyMetric,
    'thinkingEffortRequested' | 'thinkingEffortSent' | 'thinkingEffortFallback'
>;

/**
 * The reply detail's 思考 line: what the chat asked for, what was actually sent
 * and the resolver's clamping chain. Facts only; null columns are old or
 * unrecorded rows and nobody should read them as "the model default".
 */
export const thinkingEffortTextOf = (metric: ThinkingEffortFields): string => {
    const requested = metric.thinkingEffortRequested;
    const sent = metric.thinkingEffortSent;
    const fallback = metric.thinkingEffortFallback;
    if (requested === null && sent === null && fallback === null) return '未记录';
    const fallbackText = fallback === null ? '' : `，裁剪 ${fallback.split('->').join('→')}`;
    const sentText = sent === null ? '' : sent === 'off' ? ` / ${THINKING_EFFORT_OFF_LABEL}` : ` / 实际 显式${thinkingEffortLabel(sent)}`;
    if (requested === null) return `跟随厂商默认${sentText}${fallbackText}`;
    // A closed switch asked for and a closed switch sent is one fact, not two
    if (requested === 'off' && (sent === null || sent === 'off')) {
        return sent === null ? `${THINKING_EFFORT_OFF_LABEL}（未显式发送）${fallbackText}` : `${THINKING_EFFORT_OFF_LABEL}${fallbackText}`;
    }
    const requestedText = `请求 ${thinkingEffortAuditValue(requested)}`;
    return `${requestedText}${sent === null ? '（未显式发送）' : sentText}${fallbackText}`;
};

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
