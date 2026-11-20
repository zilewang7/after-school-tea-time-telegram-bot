/**
 * The probe matrix: which W1 requests are sent, and what they may cost.
 *
 * The model list comes from `--models-json` (exported from the active DB
 * catalog via `/probe export`) or falls back to the built-in `MENU_MATRIX`
 * snapshot (scripts/probe/menu-matrix.mts). The probe CLI must not import
 * `src/` (AGENTS: a script importing src imports the offline harness first,
 * and the harness rewrites DB_PATH, which would break the test-instance gate);
 * `scripts/offline/probe-matrix-sync.mts` fails when `MENU_MATRIX` drifts
 * from the runtime menu. Refresh it after a menu change:
 *
 *     npx tsx scripts/probe/refresh-menu-matrix.mts
 *
 * PROBE_PRICES keeps the fallback price rows used by the budget guard;
 * unpriced models in `--models-json` fall back to FALLBACK_PRICE with a
 * warning so auto-added models are still probed.
 *
 * W1 asks every chat model whether each candidate effort value is accepted at
 * all (one request per value, plus a baseline = the production default shape,
 * plus the deliberately rejected sentinels and client-tool fidelity variants).
 *
 * Everything here is pure and deterministic: no clock, no network, no DB. The
 * runner decides the lane and the budget; `buildProbePlan` just produces the
 * request list and the worst-case cost the guard refuses to exceed.
 */
import { MENU_MATRIX, type MenuMatrixEntry } from './menu-matrix.mts';
import {
    DEFAULT_MAX_REQUESTS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_MAX_USD,
    DEFAULT_TIMEOUT_MS,
    HARD_MAX_REQUESTS,
    HARD_MAX_USD,
    W1_OUTPUT_TOKEN_CAP,
    effortRank,
    isEffortValue,
    isProbePlatform,
    sortEfforts,
    type EffortValue,
    type ModelPrice,
    type PlanCut,
    type ProbeBudget,
    type ProbeCandidate,
    type ProbeModelSpec,
    type ProbePlan,
    type ProbePlatform,
    type ProbeVariant,
} from './effort-types.mts';

/**
 * Rough input size of one probe request (prompt, envelope and, on a fidelity
 * variant, the function declaration). Slightly generous on purpose: an
 * underestimated request would let the budget guard overshoot.
 */
const INPUT_TOKEN_ESTIMATE = 300;

const price = (inputPerMillionUsd: number, outputPerMillionUsd: number): ModelPrice => ({
    inputPerMillionUsd,
    outputPerMillionUsd,
});

/**
 * Probe prices: the probe plan §2.5 rows, USD per million input/output tokens.
 * Only the cost guard reads them (the probe never prices anything in the
 * catalog); `--models-json` rows carry their own price.
 */
const PROBE_PRICES: Readonly<Record<string, ModelPrice>> = {
    'gpt-6-luna': price(0.1, 0.5),
    'gpt-6-sol': price(2, 10),
    'gpt-6-astra': price(10, 50),
    'claude-sonnet-5-5': price(2, 10),
    'claude-opus-5-5': price(4, 20),
    'gemini-4-hydrogen': price(1.5, 7.5),
    'gemini-4-neon': price(3, 15),
    'gemini-4-carbon': price(4, 20),
    'deepseek-flash': price(0.3, 1.2),
    'grok-4.7': price(2, 6),
    'grok-4.20-multi-agent-0309': price(1.25, 2.5),
    'mimo-v2.6-flash': price(0.14, 0.28),
    'mimo-v2.6-pro': price(0.435, 0.87),
};

/** A menu model without a probe price row gets a high guess: the guard must not undershoot */
export const FALLBACK_PRICE = price(10, 50);

/** One snapshot row as a probe model; the matrix carries no price, the guard map does */
const probeSpecOf = (entry: MenuMatrixEntry): ProbeModelSpec => ({
    ...entry,
    enabled: true,
    price: PROBE_PRICES[entry.model] ?? FALLBACK_PRICE,
});

/**
 * Built-in probe matrix fallback, in chat-menu order. `--models-json` (exported
 * from the active DB catalog via `/probe export`) replaces it when provided.
 */
export const PROBE_MODEL_SNAPSHOT: readonly ProbeModelSpec[] = MENU_MATRIX.map(probeSpecOf);

/** Client-tool fidelity variants: the request shape every chat round really uses */
interface FidelityVariant {
    readonly model: string;
    readonly variant: ProbeVariant;
    readonly effort: EffortValue | null;
}

const FIDELITY_VARIANTS: readonly FidelityVariant[] = [
    { model: 'gemini-4-hydrogen', variant: 'level', effort: 'xhigh' },
    // Neon's vendor default HIGH, on the native enum path: hydrogen above already
    // covers the XHIGH extraBody shape.
    { model: 'gemini-4-neon', variant: 'level', effort: 'high' },
    { model: 'gpt-6-luna', variant: 'level', effort: 'high' },
    { model: 'gpt-6-sol', variant: 'baseline', effort: null },
    { model: 'claude-sonnet-5-5', variant: 'level', effort: 'high' },
    { model: 'grok-4.7', variant: 'level', effort: 'medium' },
    { model: 'deepseek-flash', variant: 'level', effort: 'high' },
    { model: 'mimo-v2.6-flash', variant: 'toggle-on', effort: null },
];

interface CandidateSeed {
    readonly variant: ProbeVariant;
    readonly effort: EffortValue | null;
    readonly expectedRejection?: string;
    readonly withClientTools: boolean;
}

/** W1 acceptance matrix per platform; the counts match the probe plan §2.3 */
type AcceptanceSeed = Omit<CandidateSeed, 'withClientTools'>;

const acceptanceSeeds = (model: ProbeModelSpec): CandidateSeed[] => {
    const plain = (seed: AcceptanceSeed): CandidateSeed => ({ ...seed, withClientTools: false });
    switch (model.platform) {
        case 'gemini': {
            // Gemini 4: levels exist but MINIMAL and thinkingBudget are 400s
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'level', effort: 'low' }),
                plain({ variant: 'level', effort: 'medium' }),
                plain({ variant: 'level', effort: 'high' }),
                plain({ variant: 'level', effort: 'xhigh' }),
                plain({ variant: 'level', effort: 'max', expectedRejection: 'not documented for Gemini 4; expected inert or rejected' }),
                plain({ variant: 'level', effort: 'minimal', expectedRejection: 'official docs: MINIMAL is not supported on Gemini 4' }),
                plain({ variant: 'budget', effort: null, expectedRejection: 'official docs: thinkingBudget is a 400 on Gemini 4' }),
            ];
        }
        case 'openai': {
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'level', effort: 'none' }),
                plain({ variant: 'level', effort: 'minimal', expectedRejection: 'not listed for most GPT-6 models' }),
                plain({ variant: 'level', effort: 'low' }),
                plain({ variant: 'level', effort: 'medium' }),
                plain({ variant: 'level', effort: 'high' }),
                plain({ variant: 'level', effort: 'xhigh' }),
                plain({ variant: 'level', effort: 'max' }),
            ];
        }
        case 'anthropic': {
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'level', effort: 'low' }),
                plain({ variant: 'level', effort: 'medium' }),
                plain({ variant: 'level', effort: 'high' }),
                plain({ variant: 'level', effort: 'xhigh' }),
                plain({ variant: 'level', effort: 'max' }),
                plain({ variant: 'level', effort: 'minimal', expectedRejection: 'not in the official effort table' }),
                plain({ variant: 'level', effort: 'none', expectedRejection: 'not in the official effort table' }),
            ];
        }
        case 'grok': {
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'level', effort: 'low' }),
                plain({ variant: 'level', effort: 'medium' }),
                plain({ variant: 'level', effort: 'high' }),
                plain({ variant: 'level', effort: 'xhigh' }),
                plain({ variant: 'level', effort: 'minimal', expectedRejection: 'not in the official effort list' }),
            ];
        }
        case 'deepseek': {
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'level', effort: 'low' }),
                plain({ variant: 'level', effort: 'high' }),
                plain({ variant: 'level', effort: 'max' }),
                plain({ variant: 'level', effort: 'none', expectedRejection: 'none means "thinking off" on DeepSeek, not a graded effort' }),
                plain({ variant: 'toggle-off', effort: null }),
                plain({ variant: 'level', effort: 'minimal', expectedRejection: 'DeepSeek maps minimal to low; not an accepted level' }),
                plain({ variant: 'level', effort: 'xhigh', expectedRejection: 'DeepSeek maps xhigh to high; not an accepted level' }),
            ];
        }
        case 'mimo': {
            return [
                plain({ variant: 'baseline', effort: null }),
                plain({ variant: 'toggle-on', effort: null }),
                plain({ variant: 'toggle-off', effort: null }),
                plain({ variant: 'invalid-shape', effort: null, expectedRejection: 'thinking.type accepts enabled|disabled only' }),
            ];
        }
    }
};

/**
 * Assumed output cap of one request. A wire that cannot take a token cap (the
 * xAI multi-agent model rejects max_tokens) gets a larger assumed cap: it may
 * generate more than the request asks for, and the guard must not underestimate.
 */
const assumedTokenCapOf = (model: ProbeModelSpec): number => {
    const multiAgent = model.platform === 'grok' && model.model.toLowerCase().includes('multi-agent');
    return multiAgent ? Math.max(W1_OUTPUT_TOKEN_CAP, 2_048) : W1_OUTPUT_TOKEN_CAP;
};

/** Worst-case cost of one request: the prompt plus a full W1 output cap */
export const estimateRequestCostUsd = (model: ProbeModelSpec): number => {
    const cap = assumedTokenCapOf(model);
    return (INPUT_TOKEN_ESTIMATE * model.price.inputPerMillionUsd + cap * model.price.outputPerMillionUsd) / 1_000_000;
};

const candidateId = (
    model: string,
    variant: ProbeVariant,
    effort: EffortValue | null,
    suffix: string
): string => `${model}:w1:${variant}:${effort ?? 'auto'}${suffix}`;

const makeCandidate = (
    model: ProbeModelSpec,
    seed: CandidateSeed,
    suffix: string
): ProbeCandidate => ({
    id: candidateId(model.model, seed.variant, seed.effort, suffix),
    model: model.model,
    platform: model.platform,
    wave: 'w1',
    variant: seed.variant,
    effort: seed.effort,
    withClientTools: seed.withClientTools,
    ...(seed.expectedRejection === undefined ? {} : { expectedRejection: seed.expectedRejection }),
    repeats: 1,
    estimatedCostUsd: estimateRequestCostUsd(model),
});

/** W1: acceptance matrix plus the client-tool fidelity variants */
const buildW1Candidates = (models: readonly ProbeModelSpec[]): ProbeCandidate[] => {
    const candidates: ProbeCandidate[] = [];
    for (const model of models) {
        for (const seed of acceptanceSeeds(model)) {
            candidates.push(makeCandidate(model, seed, ''));
        }
    }
    const byName = new Map(models.map((model) => [model.model, model]));
    for (const fidelity of FIDELITY_VARIANTS) {
        const model = byName.get(fidelity.model);
        if (model === undefined) continue;
        candidates.push(
            makeCandidate(
                model,
                { variant: fidelity.variant, effort: fidelity.effort, withClientTools: true },
                ':tools'
            )
        );
    }
    return candidates;
};

export interface ProbePlanOptions {
    readonly budget: ProbeBudget;
    /** External snapshot (--models-json); the built-in one when omitted */
    readonly modelSpecs?: readonly ProbeModelSpec[];
    /** Restrict the matrix to these model ids (default: every enabled snapshot row) */
    readonly models?: readonly string[];
}

/** Stable order of the platform column in tables and in lane signatures */
export const PLATFORM_ORDER: readonly ProbePlatform[] = ['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'mimo'];

const variantRank = (variant: ProbeVariant): number => {
    switch (variant) {
        case 'baseline':
            return 0;
        case 'level':
            return 1;
        case 'budget':
            return 2;
        case 'toggle-on':
            return 3;
        case 'toggle-off':
            return 4;
        case 'invalid-shape':
            return 5;
    }
};

/**
 * Cheapest first (probe plan §2.5: a 429 or a budget stop then leaves the
 * already-finished cheap models as valid data). Within a price tier the order
 * is stable: platform, model, variant, effort.
 */
const orderCandidates = (candidates: readonly ProbeCandidate[]): ProbeCandidate[] =>
    [...candidates].sort((left, right) => {
        if (left.estimatedCostUsd !== right.estimatedCostUsd) return left.estimatedCostUsd - right.estimatedCostUsd;
        const platformDelta = PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform);
        if (platformDelta !== 0) return platformDelta;
        if (left.model !== right.model) return left.model.localeCompare(right.model);
        const variantDelta = variantRank(left.variant) - variantRank(right.variant);
        if (variantDelta !== 0) return variantDelta;
        return effortRank(left.effort ?? 'none') - effortRank(right.effort ?? 'none');
    });

const totalUsdOf = (candidates: readonly ProbeCandidate[]): number =>
    Math.round(candidates.reduce((sum, candidate) => sum + candidate.estimatedCostUsd, 0) * 1_000_000) / 1_000_000;

/** Clamp the requested budget to the hard ceilings design §7 fixes */
export const clampBudget = (budget: ProbeBudget): ProbeBudget => ({
    maxRequests: Math.max(1, Math.min(Math.trunc(budget.maxRequests), HARD_MAX_REQUESTS)),
    maxUsd: Math.max(0.01, Math.min(budget.maxUsd, HARD_MAX_USD)),
    timeoutMs: Math.max(5_000, Math.trunc(budget.timeoutMs)),
    maxRetries: Math.max(0, Math.min(Math.trunc(budget.maxRetries), 3)),
});

export const defaultBudget = (): ProbeBudget =>
    clampBudget({
        maxRequests: DEFAULT_MAX_REQUESTS,
        maxUsd: DEFAULT_MAX_USD,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxRetries: DEFAULT_MAX_RETRIES,
    });

const selectedModels = (options: ProbePlanOptions): ProbeModelSpec[] => {
    const wanted = options.models === undefined ? null : new Set(options.models);
    const source = options.modelSpecs ?? PROBE_MODEL_SNAPSHOT;
    return source.filter((model) => model.enabled && (wanted === null || wanted.has(model.model)));
};

/** Drop candidates after the budget is no longer sufficient; keep the cheapest */
const cutToBudget = (
    ordered: readonly ProbeCandidate[],
    budget: ProbeBudget
): { readonly kept: ProbeCandidate[]; readonly cut: PlanCut } => {
    const kept: ProbeCandidate[] = [];
    let usd = 0;
    let droppedRequests = 0;
    let droppedUsd = 0;
    let countReason = false;
    let usdReason = false;
    for (const candidate of ordered) {
        const exceedsCount = kept.length + 1 > budget.maxRequests;
        const exceedsUsd = Math.round((usd + candidate.estimatedCostUsd) * 1_000_000) / 1_000_000 > budget.maxUsd;
        if (exceedsCount || exceedsUsd) {
            droppedRequests += 1;
            droppedUsd += candidate.estimatedCostUsd;
            if (exceedsCount) countReason = true;
            if (exceedsUsd) usdReason = true;
            continue;
        }
        kept.push(candidate);
        usd += candidate.estimatedCostUsd;
    }
    const reasons: string[] = [];
    if (countReason) reasons.push(`--max-requests ${budget.maxRequests}`);
    if (usdReason) reasons.push(`--max-usd ${budget.maxUsd.toFixed(2)}`);
    return {
        kept,
        cut: {
            droppedRequests,
            droppedUsd: Math.round(droppedUsd * 1_000_000) / 1_000_000,
            reasons,
        },
    };
};

/**
 * Build the W1 probe plan. The result is deterministic for the same options,
 * which the dry-run table and the tests rely on.
 */
export const buildProbePlan = (options: ProbePlanOptions): ProbePlan => {
    const models = selectedModels(options);
    const budget = clampBudget(options.budget);
    const ordered = orderCandidates(buildW1Candidates(models));
    const { kept, cut } = cutToBudget(ordered, budget);
    return {
        wave: 'w1',
        models,
        candidates: kept,
        requests: kept.length,
        estimatedUsd: totalUsdOf(kept),
        cut,
    };
};

export interface ModelsJsonProblem {
    readonly index: number;
    readonly message: string;
}

export interface ModelsJsonResult {
    readonly models: readonly ProbeModelSpec[];
    readonly problems: readonly ModelsJsonProblem[];
}

const effortListOf = (value: unknown): EffortValue[] => {
    if (!Array.isArray(value)) return [];
    const efforts: EffortValue[] = [];
    for (const item of value) {
        if (typeof item === 'string' && isEffortValue(item)) {
            efforts.push(item);
        }
    }
    return sortEfforts(efforts);
};

/**
 * Accept an exported catalog snapshot (`--models-json`). The file is the only
 * dynamic input: the probe must not read the database. Shape problems become
 * warnings and the row is skipped rather than silently probed wrong.
 */
export const parseModelsJson = (value: unknown): ModelsJsonResult => {
    const problems: ModelsJsonProblem[] = [];
    if (!Array.isArray(value)) {
        return { models: [], problems: [{ index: -1, message: 'the file must be a JSON array of model entries' }] };
    }
    const entries: unknown[] = value;
    const models: ProbeModelSpec[] = [];
    entries.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            problems.push({ index, message: 'not an object' });
            return;
        }
        const record = Object.fromEntries(Object.entries(entry));
        const model = record['model'];
        const platform = record['platform'];
        if (typeof model !== 'string' || model === '') {
            problems.push({ index, message: 'missing model id' });
            return;
        }
        if (typeof platform !== 'string' || !isProbePlatform(platform)) {
            problems.push({ index, message: `${model}: unknown platform` });
            return;
        }
        const rawPrice = record['price'];
        const priceRecord = typeof rawPrice === 'object' && rawPrice !== null && !Array.isArray(rawPrice)
            ? Object.fromEntries(Object.entries(rawPrice))
            : null;
        const inputPrice = priceRecord === null ? null : Number(priceRecord['inputPerMillionUsd']);
        const outputPrice = priceRecord === null ? null : Number(priceRecord['outputPerMillionUsd']);
        const hasValidPrice =
            inputPrice !== null &&
            outputPrice !== null &&
            Number.isFinite(inputPrice) &&
            Number.isFinite(outputPrice) &&
            inputPrice >= 0 &&
            outputPrice >= 0;
        if (!hasValidPrice) {
            problems.push({
                index,
                message: `${model}: missing or invalid price, falling back to $${FALLBACK_PRICE.inputPerMillionUsd}/$${FALLBACK_PRICE.outputPerMillionUsd} per 1M`,
            });
        }
        const resolvedPrice = hasValidPrice
            ? { inputPerMillionUsd: inputPrice, outputPerMillionUsd: outputPrice }
            : FALLBACK_PRICE;
        const defaultEffort = record['vendorDefaultEffort'];
        const defaultEnabled = record['vendorDefaultEnabled'];
        models.push({
            model,
            platform,
            enabled: record['enabled'] !== false,
            vendorEfforts: effortListOf(record['vendorEfforts']),
            vendorDefaultEffort:
                typeof defaultEffort === 'string' && isEffortValue(defaultEffort) ? defaultEffort : null,
            vendorToggle: record['vendorToggle'] === true,
            vendorDefaultEnabled: typeof defaultEnabled === 'boolean' ? defaultEnabled : null,
            price: resolvedPrice,
            ...(typeof record['note'] === 'string' ? { note: record['note'] } : {}),
        });
    });
    return { models, problems };
};

/** Select models from an external snapshot, otherwise the built-in one */
export const resolveModelSpecs = (
    external: ModelsJsonResult | null,
    wanted: readonly string[] | undefined
): ProbeModelSpec[] => {
    const source = external === null ? PROBE_MODEL_SNAPSHOT : external.models;
    const wantedSet = wanted === undefined ? null : new Set(wanted);
    return source.filter((model) => model.enabled && (wantedSet === null || wantedSet.has(model.model)));
};
