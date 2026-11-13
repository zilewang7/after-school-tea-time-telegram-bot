/**
 * The probe matrix: which requests W1/W2 would send, and what they may cost.
 *
 * The model list is the `MENU_MATRIX` snapshot (scripts/probe/menu-matrix.mts),
 * generated from the runtime chat menu and the capability seed by
 * `scripts/probe/refresh-menu-matrix.mts`. The probe CLI must not import `src/`
 * (AGENTS: a script importing src imports the offline harness first, and the
 * harness rewrites DB_PATH, which would break the test-instance gate), so the
 * snapshot is the only source here; `scripts/offline/probe-matrix-sync.mts`
 * fails when it drifts from the runtime menu. Refresh it after a menu change:
 *
 *     npx tsx scripts/probe/refresh-menu-matrix.mts
 *
 * PROBE_PRICES keeps the probe plan §2.5 price rows used by the budget guard;
 * the image catalog rows (not chat menu entries) stay out of the matrix.
 *
 * W1 asks every chat model whether each candidate effort value is accepted at
 * all (one request per value, plus a baseline = the production default shape,
 * plus the deliberately rejected sentinels). W2 repeats a representative subset
 * enough times to compare reasoning-token counts and infer the vendor default.
 * Counts follow from the menu: W1 total = acceptance records + 8 client-tool
 * fidelity variants, W2 = 7 representative models × 7 samples.
 *
 * Everything here is pure and deterministic: no clock, no network, no DB. The
 * runner decides the lane and the budget; `buildProbePlan` just produces the
 * request list and the worst-case cost the guard refuses to exceed.
 */
import { MENU_MATRIX, type MenuMatrixEntry } from './menu-matrix.mts';
import {
    DEFAULT_MAX_RETRIES,
    DEFAULT_MAX_USD,
    DEFAULT_TIMEOUT_MS,
    HARD_MAX_REQUESTS,
    HARD_MAX_USD,
    MAX_W2_OUTPUT_TOKEN_CAP,
    MIN_W2_OUTPUT_TOKEN_CAP,
    W1_OUTPUT_TOKEN_CAP,
    W2_OUTPUT_TOKEN_CAP,
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
    type ProbeWave,
    type WaveTotals,
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
    'gemini-4-argon': price(4, 20),
    'gemini-4-carbon': price(4, 20),
    'deepseek-flash': price(0.3, 1.2),
    'grok-4.7': price(2, 6),
    'grok-4.20-multi-agent-0309': price(1.25, 2.5),
    'mimo-v2.6-flash': price(0.14, 0.28),
    'mimo-v2.6-pro': price(0.435, 0.87),
};

/** A menu model without a probe price row gets a high guess: the guard must not undershoot */
const FALLBACK_PRICE = price(10, 50);

/** One snapshot row as a probe model; the matrix carries no price, the guard map does */
const probeSpecOf = (entry: MenuMatrixEntry): ProbeModelSpec => ({
    ...entry,
    enabled: true,
    price: PROBE_PRICES[entry.model] ?? FALLBACK_PRICE,
});

/**
 * The probe matrix, in chat-menu order. The W2 representatives and the
 * client-tool fidelity variants below name menu ids too, so every one of them
 * is always part of this list. `--models-json` can still replace it with an
 * exported catalog snapshot when the catalog moved on between releases.
 */
export const PROBE_MODEL_SNAPSHOT: readonly ProbeModelSpec[] = MENU_MATRIX.map(probeSpecOf);

/** W2 representatives: cheap and expensive families, one or two per platform */
export const W2_REPRESENTATIVE_MODELS: readonly string[] = [
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gpt-6-luna',
    'claude-sonnet-5-5',
    'grok-4.7',
    'deepseek-flash',
    'mimo-v2.6-flash',
];

/** Client-tool fidelity variants: the request shape every chat round really uses */
interface FidelityVariant {
    readonly model: string;
    readonly variant: ProbeVariant;
    readonly effort: EffortValue | null;
}

const FIDELITY_VARIANTS: readonly FidelityVariant[] = [
    { model: 'gemini-4-hydrogen', variant: 'level', effort: 'xhigh' },
    { model: 'gemini-4-argon', variant: 'level', effort: 'high' },
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

/** Output cap of one wave; the budget (CLI --w2-cap) may raise or lower W2 */
const tokenCapOf = (wave: ProbeWave, w2OutputTokenCap: number | undefined): number =>
    wave === 'w2' ? (w2OutputTokenCap ?? W2_OUTPUT_TOKEN_CAP) : W1_OUTPUT_TOKEN_CAP;

/**
 * Assumed output cap of one request. A wire that cannot take a token cap (the
 * xAI multi-agent model rejects max_tokens) gets a larger assumed cap: it may
 * generate more than the request asks for, and the guard must not underestimate.
 */
const assumedTokenCapOf = (model: ProbeModelSpec, wave: ProbeWave, w2OutputTokenCap: number | undefined): number => {
    const multiAgent = model.platform === 'grok' && model.model.toLowerCase().includes('multi-agent');
    return multiAgent ? Math.max(tokenCapOf(wave, w2OutputTokenCap), 2_048) : tokenCapOf(wave, w2OutputTokenCap);
};

/** Worst-case cost of one request: the prompt plus a full output cap */
export const estimateRequestCostUsd = (
    model: ProbeModelSpec,
    wave: ProbeWave,
    w2OutputTokenCap?: number
): number => {
    const cap = assumedTokenCapOf(model, wave, w2OutputTokenCap);
    return (INPUT_TOKEN_ESTIMATE * model.price.inputPerMillionUsd + cap * model.price.outputPerMillionUsd) / 1_000_000;
};

const candidateId = (
    model: string,
    wave: ProbeWave,
    variant: ProbeVariant,
    effort: EffortValue | null,
    suffix: string
): string => `${model}:${wave}:${variant}:${effort ?? 'auto'}${suffix}`;

const makeCandidate = (
    model: ProbeModelSpec,
    wave: ProbeWave,
    seed: CandidateSeed,
    suffix: string,
    repeats: number,
    w2OutputTokenCap?: number
): ProbeCandidate => ({
    id: candidateId(model.model, wave, seed.variant, seed.effort, suffix),
    model: model.model,
    platform: model.platform,
    wave,
    variant: seed.variant,
    effort: seed.effort,
    withClientTools: seed.withClientTools,
    ...(seed.expectedRejection === undefined ? {} : { expectedRejection: seed.expectedRejection }),
    repeats,
    estimatedCostUsd: estimateRequestCostUsd(model, wave, w2OutputTokenCap) * repeats,
});

/** W1: acceptance matrix plus the client-tool fidelity variants */
const buildW1Candidates = (models: readonly ProbeModelSpec[]): ProbeCandidate[] => {
    const candidates: ProbeCandidate[] = [];
    for (const model of models) {
        for (const seed of acceptanceSeeds(model)) {
            candidates.push(makeCandidate(model, 'w1', seed, '', 1));
        }
    }
    const byName = new Map(models.map((model) => [model.model, model]));
    for (const fidelity of FIDELITY_VARIANTS) {
        const model = byName.get(fidelity.model);
        if (model === undefined) continue;
        candidates.push(
            makeCandidate(
                model,
                'w1',
                { variant: fidelity.variant, effort: fidelity.effort, withClientTools: true },
                ':tools',
                1
            )
        );
    }
    return candidates;
};

/**
 * The two effort values W2 samples per model: the vendor default (so the
 * inference can compare the baseline against a real candidate) and the far end
 * of the accepted range (so "higher effort really thinks more" is verifiable).
 */
const w2EffortsOf = (
    model: ProbeModelSpec,
    acceptedEfforts: readonly EffortValue[] | undefined
): readonly CandidateSeed[] => {
    const efforts = sortEfforts(acceptedEfforts ?? model.vendorEfforts).filter(
        (effort) => effort !== 'none' || model.platform !== 'gemini'
    );
    if (efforts.length >= 2) {
        const first = efforts[0];
        const last = efforts[efforts.length - 1];
        if (first === undefined || last === undefined) return [];
        const primary =
            model.vendorDefaultEffort !== null && efforts.some((effort) => effort === model.vendorDefaultEffort)
                ? model.vendorDefaultEffort
                : first;
        const contrast = primary === last ? first : last;
        return [
            { variant: 'level', effort: primary, withClientTools: false },
            { variant: 'level', effort: contrast, withClientTools: false },
        ];
    }
    if (model.vendorToggle) {
        // Toggle-only models: the contrast that matters is enabled vs disabled
        return [
            { variant: 'toggle-on', effort: null, withClientTools: false },
            { variant: 'toggle-off', effort: null, withClientTools: false },
        ];
    }
    return efforts.map((effort) => ({ variant: 'level', effort, withClientTools: false }));
};

/** W2: baseline ×3 and the two sampled efforts ×2 for each representative model */
const buildW2Candidates = (
    models: readonly ProbeModelSpec[],
    acceptedEffortsByModel: Readonly<Record<string, readonly EffortValue[]>>,
    w2OutputTokenCap: number | undefined
): ProbeCandidate[] => {
    const candidates: ProbeCandidate[] = [];
    for (const model of models) {
        for (let repeat = 1; repeat <= 3; repeat += 1) {
            candidates.push(
                makeCandidate(model, 'w2', { variant: 'baseline', effort: null, withClientTools: false }, `#${repeat}`, 1, w2OutputTokenCap)
            );
        }
        for (const seed of w2EffortsOf(model, acceptedEffortsByModel[model.model])) {
            for (let repeat = 1; repeat <= 2; repeat += 1) {
                candidates.push(makeCandidate(model, 'w2', seed, `#${repeat}`, 1, w2OutputTokenCap));
            }
        }
    }
    return candidates;
};

export interface ProbePlanOptions {
    readonly wave: ProbeWave | 'all';
    readonly budget: ProbeBudget;
    /** External snapshot (--models-json); the built-in one when omitted */
    readonly modelSpecs?: readonly ProbeModelSpec[];
    /** Restrict the matrix to these model ids (default: every enabled snapshot row) */
    readonly models?: readonly string[];
    /** W1 results a W2-only run depends on (`efforts` per model) */
    readonly acceptedEffortsByModel?: Readonly<Record<string, readonly EffortValue[]>>;
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
 * is stable: W1 before W2, then platform, model, variant, effort.
 */
const orderCandidates = (candidates: readonly ProbeCandidate[]): ProbeCandidate[] =>
    [...candidates].sort((left, right) => {
        if (left.estimatedCostUsd !== right.estimatedCostUsd) return left.estimatedCostUsd - right.estimatedCostUsd;
        if (left.wave !== right.wave) return left.wave === 'w1' ? -1 : 1;
        const platformDelta = PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform);
        if (platformDelta !== 0) return platformDelta;
        if (left.model !== right.model) return left.model.localeCompare(right.model);
        const variantDelta = variantRank(left.variant) - variantRank(right.variant);
        if (variantDelta !== 0) return variantDelta;
        return effortRank(left.effort ?? 'none') - effortRank(right.effort ?? 'none');
    });

const totalsOf = (candidates: readonly ProbeCandidate[]): WaveTotals => ({
    requests: candidates.length,
    estimatedUsd: Math.round(candidates.reduce((sum, candidate) => sum + candidate.estimatedCostUsd, 0) * 1_000_000) / 1_000_000,
});

/** Clamp the requested budget to the hard ceilings design §7 fixes */
export const clampBudget = (budget: ProbeBudget): ProbeBudget => ({
    maxRequests: Math.max(1, Math.min(Math.trunc(budget.maxRequests), HARD_MAX_REQUESTS)),
    maxUsd: Math.max(0.01, Math.min(budget.maxUsd, HARD_MAX_USD)),
    timeoutMs: Math.max(5_000, Math.trunc(budget.timeoutMs)),
    maxRetries: Math.max(0, Math.min(Math.trunc(budget.maxRetries), 3)),
    ...(budget.w2OutputTokenCap === undefined
        ? {}
        : { w2OutputTokenCap: Math.max(MIN_W2_OUTPUT_TOKEN_CAP, Math.min(Math.trunc(budget.w2OutputTokenCap), MAX_W2_OUTPUT_TOKEN_CAP)) }),
});

export const defaultBudget = (wave: ProbeWave | 'all'): ProbeBudget =>
    clampBudget({
        maxRequests: wave === 'all' ? HARD_MAX_REQUESTS : wave === 'w2' ? 60 : 120,
        maxUsd: DEFAULT_MAX_USD,
        // The effect wave can think for a minute; using its timeout everywhere is safe
        timeoutMs: wave === 'all' || wave === 'w2' ? 150_000 : DEFAULT_TIMEOUT_MS,
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
 * Build the plan for one wave (or every wave). The result is deterministic for
 * the same options, which the dry-run table and the tests rely on.
 */
export const buildProbePlan = (options: ProbePlanOptions): ProbePlan => {
    const models = selectedModels(options);
    const budget = clampBudget(options.budget);
    const w1 = options.wave === 'w2' ? [] : buildW1Candidates(models);
    const w2Models =
        options.wave === 'w1'
            ? []
            : models.filter((model) => W2_REPRESENTATIVE_MODELS.some((name) => name === model.model));
    const w2 =
        options.wave === 'w1' ? [] : buildW2Candidates(w2Models, options.acceptedEffortsByModel ?? {}, budget.w2OutputTokenCap);
    const ordered = orderCandidates([...w1, ...w2]);
    const { kept, cut } = cutToBudget(ordered, budget);
    const plannedModels = options.wave === 'w2' ? w2Models : models;
    const perWave: Record<ProbeWave, WaveTotals> = {
        w1: totalsOf(kept.filter((candidate) => candidate.wave === 'w1')),
        w2: totalsOf(kept.filter((candidate) => candidate.wave === 'w2')),
    };
    return {
        wave: options.wave,
        models: plannedModels,
        candidates: kept,
        requests: kept.length,
        estimatedUsd: perWave.w1.estimatedUsd + perWave.w2.estimatedUsd,
        perWave,
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
        if (inputPrice === null || outputPrice === null || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) {
            problems.push({ index, message: `${model}: missing price` });
            return;
        }
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
            price: { inputPerMillionUsd: inputPrice, outputPerMillionUsd: outputPrice },
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
