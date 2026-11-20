/**
 * Shared vocabulary of the one-off thinking-effort probe (scripts/probe only).
 *
 * Nothing here imports `src/`: the probe must run in the test container without
 * the bot's modules, its database or its environment side effects. The values
 * mirror design §7 and the model snapshot of docs/2026-1113-1742.
 */

/** Effort values in ascending order; the product's closed set (design §1.2) */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type EffortValue = (typeof EFFORT_ORDER)[number];

/** Chinese labels of the effort words, mirroring the product menu (design §4.3) */
export const EFFORT_LABELS: Readonly<Record<EffortValue, string>> = {
    none: '无',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
    ultra: '极限',
};

/** The six lanes the probe talks to */
export const PROBE_PLATFORMS = ['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'mimo'] as const;

export type ProbePlatform = (typeof PROBE_PLATFORMS)[number];

/** Canonical order for legacy v1 laneSignature parsing */
export const PLATFORM_ORDER_LIST: readonly ProbePlatform[] = PROBE_PLATFORMS;

/** Only W1 acceptance + client-tool fidelity remains in v2 (§3.6) */
export const PROBE_WAVES = ['w1'] as const;

export type ProbeWave = (typeof PROBE_WAVES)[number];

/**
 * What a candidate tests beyond "send this effort value":
 * - baseline: the production default shape (no explicit effort)
 * - level: an explicit effort value
 * - budget: Gemini 4's removed `thinkingBudget` (expected 400 sentinel)
 * - toggle-on / toggle-off: `thinking.type` switches (DeepSeek, MiMo)
 * - invalid-shape: a deliberately malformed value (expected 400 sentinel)
 */
export type ProbeVariant = 'baseline' | 'level' | 'budget' | 'toggle-on' | 'toggle-off' | 'invalid-shape';

export const PROBE_VARIANTS: readonly ProbeVariant[] = [
    'baseline',
    'level',
    'budget',
    'toggle-on',
    'toggle-off',
    'invalid-shape',
];

/** One model as the plan sees it; a snapshot, not a DB read */
export interface ProbeModelSpec {
    readonly model: string;
    readonly platform: ProbePlatform;
    /** Participates in the default W1 matrix */
    readonly enabled: boolean;
    /** Vendor-documented accepted efforts (models.dev / official docs snapshot) */
    readonly vendorEfforts: readonly EffortValue[];
    /** Vendor default effort; null when the vendor does not document one */
    readonly vendorDefaultEffort: EffortValue | null;
    readonly vendorToggle: boolean;
    readonly vendorDefaultEnabled: boolean | null;
    /** Standard-tier price per million tokens, used only for the budget guard */
    readonly price: ModelPrice;
    readonly note?: string;
}

export interface ModelPrice {
    readonly inputPerMillionUsd: number;
    readonly outputPerMillionUsd: number;
}

/** One planned request */
export interface ProbeCandidate {
    /** Stable id: `<model>:<wave>:<variant>:<effort|baseline>` */
    readonly id: string;
    readonly model: string;
    readonly platform: ProbePlatform;
    readonly wave: ProbeWave;
    readonly variant: ProbeVariant;
    /** Explicit effort value; null for baseline/toggle candidates */
    readonly effort: EffortValue | null;
    readonly withClientTools: boolean;
    /** Why the vendor is expected to reject it; only set for negative sentinels */
    readonly expectedRejection?: string;
    /** 1 in W1; the repeat index is part of the id in W2 */
    readonly repeats: number;
    /** Worst-case cost at the wave's token cap (the budget guard's unit) */
    readonly estimatedCostUsd: number;
}

/** The hard stops of one run (design §7 / probe plan §5) */
export interface ProbeBudget {
    readonly maxRequests: number;
    readonly maxUsd: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
}

export interface ProbePlan {
    readonly wave: ProbeWave;
    readonly models: readonly ProbeModelSpec[];
    readonly candidates: readonly ProbeCandidate[];
    readonly requests: number;
    readonly estimatedUsd: number;
    readonly cut: PlanCut;
}

/** What the budget guard dropped, so `--dry-run` can say it out loud */
export interface PlanCut {
    readonly droppedRequests: number;
    readonly droppedUsd: number;
    readonly reasons: readonly string[];
}

/** Normalized outcome of one wire request, before retries and inference */
export type ProbeWireOutcome = 'accepted' | 'rejected' | 'error';

export interface ProbeObservation {
    readonly candidateId: string;
    readonly model: string;
    readonly platform: ProbePlatform;
    readonly wave: ProbeWave;
    readonly variant: ProbeVariant;
    readonly effort: EffortValue | null;
    readonly withClientTools: boolean;
    /** Why the vendor was expected to reject it; null for ordinary candidates */
    readonly expectedRejection: string | null;
    /** 1-based; retries produce a second observation for the same candidate */
    readonly attempt: number;
    readonly startedAt: string;
    readonly totalMs: number;
    /** Time until the first response byte arrived (headers or first event) */
    readonly ttfbMs: number | null;
    readonly firstThinkingMs: number | null;
    readonly status: number | null;
    readonly outcome: ProbeWireOutcome;
    readonly errorClass: string | null;
    readonly errorFingerprint: string | null;
    /** Redacted, at most ERROR_SUMMARY_LIMIT characters */
    readonly errorSummary: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly reasoningTokens: number | null;
    readonly totalTokens: number | null;
    readonly textChars: number;
    readonly thinkingChars: number;
    readonly finishReason: string | null;
    readonly streamError: string | null;
    /** Redacted body actually sent (≤ EVIDENCE_LIMIT characters) */
    readonly requestExcerpt: string;
    /** Redacted error body or stream excerpt (≤ EVIDENCE_LIMIT characters) */
    readonly responseExcerpt: string;
    /** Whitelisted routing/rate-limit headers only */
    readonly laneHeaders: Readonly<Record<string, string>>;
    readonly laneId: string;
    /** Planned worst case; what the run reserves before the request is sent */
    readonly estimatedCostUsd: number;
    /** Usage-derived cost when the lane reported usage, planned cost otherwise */
    readonly costUsd: number;
    readonly usageReported: boolean;
}

/** Client-tool fidelity check result recorded in v2 results.json */
export interface ProbeToolsCheck {
    readonly supported: boolean;
    readonly variant: ProbeVariant;
    readonly effort: EffortValue | null;
    readonly error?: string;
}

/** Per-platform lane fingerprints (map from platform to laneId#hash) */
export type ProbeLaneFingerprints = Readonly<Partial<Record<ProbePlatform, string>>>;

/** One importable row of the v2 result document (§3.6): measured facts only */
export interface ProbeResultEntryV2 {
    readonly model: string;
    readonly platform: ProbePlatform;
    readonly lane: string;
    readonly acceptedEfforts: readonly EffortValue[];
    readonly mappedEfforts: readonly EffortValue[];
    readonly toggle: boolean | null;
    readonly tools: ProbeToolsCheck | null;
    readonly errorSummary: Readonly<Record<string, string>>;
    readonly checkedOn: string;
}

/** Legacy v1 row (design 2026-1113-1742 §7), still accepted by --check / --merge / /probe import */
export interface ProbeResultEntryV1 {
    readonly model: string;
    readonly acceptedEfforts: readonly EffortValue[];
    readonly defaultEffort: EffortValue | null;
    readonly toggle: boolean;
    readonly errorSummary: Readonly<Record<string, string>>;
    readonly checkedOn: string;
}

export type ProbeResultEntry = ProbeResultEntryV2 | ProbeResultEntryV1;

/** The v2 document `scripts/probe/thinking-effort.mts` writes (§3.6) */
export interface ProbeResultDocumentV2 {
    readonly schema: 2;
    readonly probedAt: string;
    readonly lanes: ProbeLaneFingerprints;
    readonly results: readonly ProbeResultEntryV2[];
}

/** Legacy v1 document still accepted on import / validation / merge */
export interface ProbeResultDocumentV1 {
    readonly schema: 1;
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly results: readonly ProbeResultEntryV1[];
}

export type ProbeResultDocument = ProbeResultDocumentV2 | ProbeResultDocumentV1;

export interface ValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
    readonly document: ProbeResultDocument | null;
}

/** Longest text kept from an error body, after redaction */
export const ERROR_SUMMARY_LIMIT = 800;

/** Longest normalized fingerprint used for de-duplication */
export const ERROR_FINGERPRINT_LIMIT = 200;

/** Longest request/response excerpt written to observations.json */
export const EVIDENCE_LIMIT = 2_000;

/** Design §7 hard ceiling: the whole run may never exceed these */
export const HARD_MAX_REQUESTS = 250;
export const HARD_MAX_USD = 5;

/** Defaults: $3 hard user-facing cap */
export const DEFAULT_MAX_USD = 3;
export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_RETRIES = 1;

/** Default request ceiling for a W1 run */
export const DEFAULT_MAX_REQUESTS = HARD_MAX_REQUESTS;

/** Output token cap: W1 only needs a valid stream */
export const W1_OUTPUT_TOKEN_CAP = 256;

/** Jitter between requests, so one lane's rate limiter is not hammered */
export const REQUEST_PACING_MIN_MS = 1_500;
export const REQUEST_PACING_MAX_MS = 3_000;

/** Backoff before the single allowed retry */
export const RETRY_DELAY_MS = 5_000;

/** Circuit breakers: a lane that keeps answering these is not worth spending on */
export const LANE_429_LIMIT = 3;
export const LANE_5XX_LIMIT = 2;

/**
 * The prompt every probe request sends. It asks for a short computation so the
 * model has a reason to think; a trivial prompt could make W2's reasoning-token
 * comparison meaningless.
 */
export const PROBE_PROMPT = 'Compute 137*291 + 5 step by step, then reply with only the final number.';

/** Request/response header whitelist recorded as lane evidence */
export const LANE_HEADER_NAMES: readonly string[] = [
    'x-axonhub-routed-via',
    'x-axonhub-fallback-attempts',
    'x-request-id',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'request-id',
    'openai-processing-ms',
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining',
    'x-ephone-request-id',
    'x-ephone-channel',
    'cf-ray',
    'cf-cache-status',
];

/** True when `value` is one of the product's effort words */
export const isEffortValue = (value: string): value is EffortValue =>
    EFFORT_ORDER.some((effort) => effort === value);

/** True when `value` is one of the six probe platforms */
export const isProbePlatform = (value: string): value is ProbePlatform =>
    PROBE_PLATFORMS.some((platform) => platform === value);

/** Ascending index of an effort; -1 when unknown */
export const effortRank = (value: string): number => EFFORT_ORDER.findIndex((effort) => effort === value);

/** Sorted copy of `values`, de-duplicated, ascending */
export const sortEfforts = (values: readonly EffortValue[]): EffortValue[] =>
    [...new Set(values)].sort((left, right) => effortRank(left) - effortRank(right));

/** Narrow a parsed JSON value to a plain object without a cast */
export const recordOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;

/** A finite number from a JSON value (number or numeric string), else null */
export const numberAt = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};
