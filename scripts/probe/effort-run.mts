/**
 * The probe orchestrator: budget, retries, circuit breakers, files.
 *
 * One request at a time (design §7: concurrency 1): sequential traffic keeps
 * spend predictable, avoids tripping lane rate limits and keeps the recorded
 * evidence readable. The cheap models run first, so a 429 storm or a budget
 * stop leaves the already-finished cheap models as valid data.
 *
 * Nothing here starts the bot, touches Telegram or opens the DB; the only
 * writable place is the run directory under tmp/thinking-probe/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorClassLabel } from './effort-errors.mts';
import { laneSignatureOf, type ProbeEnvironment, type ProbeLaneConfiguration } from './effort-env.mts';
import type { ProbeLane } from './effort-lanes.mts';
import { buildProbePlan, clampBudget, type ProbePlanOptions } from './effort-plan.mts';
import {
    billedCostUsd,
    buildRunSummary,
    formatPlanTable,
    formatSummaryMarkdown,
    summarizeModel,
    type ModelInference,
    type ProbeRunSummary,
} from './effort-results.mts';
import {
    LANE_429_LIMIT,
    LANE_5XX_LIMIT,
    REQUEST_PACING_MAX_MS,
    REQUEST_PACING_MIN_MS,
    RETRY_DELAY_MS,
    W1_OUTPUT_TOKEN_CAP,
    W2_OUTPUT_TOKEN_CAP,
    type EffortValue,
    type ProbeCandidate,
    type ProbeModelSpec,
    type ProbeBudget,
    type ProbeObservation,
    type ProbePlan,
    type ProbePlatform,
    type ProbeResultDocument,
    type ProbeWave,
} from './effort-types.mts';

const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['rate_limited', 'upstream_error', 'network_error']);

const TOGGLE_PLATFORMS: ReadonlySet<ProbePlatform> = new Set<ProbePlatform>(['deepseek', 'mimo']);

export interface SkippedCandidate {
    readonly candidateId: string;
    readonly model: string;
    readonly platform: ProbePlatform;
    readonly reason: string;
}

export interface ProbeRunOptions {
    readonly wave: ProbeWave | 'all';
    readonly budget: ProbeBudget;
    readonly models?: readonly string[];
    readonly modelSpecs?: readonly ProbeModelSpec[];
    readonly acceptedEffortsByModel?: Readonly<Record<string, readonly EffortValue[]>>;
    /** Default true: build the plan and write it, send nothing */
    readonly dryRun: boolean;
    /** W0: lanes already point at the in-process stub */
    readonly stub: boolean;
    readonly lanes: Readonly<Record<ProbePlatform, ProbeLane>>;
    readonly environment: ProbeEnvironment;
    /** Absolute run directory; the CLI keeps it under tmp/thinking-probe/ */
    readonly outDir: string;
    readonly gates: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
    readonly signal?: AbortSignal;
    /** Between requests; null in tests and the stub */
    readonly pacingMs?: { readonly min: number; readonly max: number } | null;
    readonly retryDelayMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => Date;
    readonly log?: (line: string) => void;
}

export interface ProbeRunOutcome {
    readonly dryRun: boolean;
    readonly stub: boolean;
    readonly laneSignature: string;
    readonly plan: ProbePlan;
    readonly observations: readonly ProbeObservation[];
    readonly skipped: readonly SkippedCandidate[];
    readonly summary: ProbeRunSummary | null;
    readonly document: ProbeResultDocument | null;
    readonly inferences: readonly ModelInference[];
    readonly requestCount: number;
    readonly retryCount: number;
    readonly spentUsd: number;
    readonly stoppedReason: string | null;
    readonly files: readonly string[];
    readonly startedAt: string;
    readonly finishedAt: string;
}

// The delay is awaited, so the timer must not be unref'd: an unref'd timer is
// not a reason to keep the process alive, and the await would never settle.
const defaultSleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

/** Output cap of one wave; the budget's --w2-cap overrides the W2 default */
const tokenCapOf = (wave: ProbeWave, budget: ProbeBudget): number =>
    wave === 'w2' ? (budget.w2OutputTokenCap ?? W2_OUTPUT_TOKEN_CAP) : W1_OUTPUT_TOKEN_CAP;

const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/** One request's hard abort; the SDK has its own timeout, this is the backstop */
const withRequestTimeout = async <T,>(
    timeoutMs: number,
    outerSignal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const onOuterAbort = (): void => controller.abort();
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
        return await body(controller.signal);
    } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
    }
};

/** Charge: real usage when reported, nothing for an unbilled 4xx, reservation otherwise */
const chargeOf = (spec: ProbeModelSpec, observation: ProbeObservation): number => {
    if (observation.usageReported) return billedCostUsd(spec, observation);
    if (observation.status !== null && observation.status >= 400 && observation.status < 500) return 0;
    return observation.estimatedCostUsd;
};

interface RunnerState {
    readonly observations: ProbeObservation[];
    readonly skipped: SkippedCandidate[];
    requestCount: number;
    retryCount: number;
    spentUsd: number;
    stoppedReason: string | null;
    readonly stoppedLanes: Set<ProbePlatform>;
    readonly stoppedModels: Set<string>;
    readonly lane429: Map<ProbePlatform, number>;
    readonly lane5xx: Map<ProbePlatform, number>;
}

const createRunnerState = (): RunnerState => ({
    observations: [],
    skipped: [],
    requestCount: 0,
    retryCount: 0,
    spentUsd: 0,
    stoppedReason: null,
    stoppedLanes: new Set(),
    stoppedModels: new Set(),
    lane429: new Map(),
    lane5xx: new Map(),
});

const laneConfigurationsOf = (
    lanes: Readonly<Record<ProbePlatform, ProbeLane>>
): Record<ProbePlatform, ProbeLaneConfiguration> => ({
    gemini: lanes.gemini.configuration,
    openai: lanes.openai.configuration,
    anthropic: lanes.anthropic.configuration,
    grok: lanes.grok.configuration,
    deepseek: lanes.deepseek.configuration,
    mimo: lanes.mimo.configuration,
});

const planOptionsOf = (options: ProbeRunOptions, wave: ProbeWave | 'all', budget: ProbeBudget): ProbePlanOptions => ({
    wave,
    budget,
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.modelSpecs === undefined ? {} : { modelSpecs: options.modelSpecs }),
    ...(options.acceptedEffortsByModel === undefined ? {} : { acceptedEffortsByModel: options.acceptedEffortsByModel }),
});

/** Presence-only env report; values (and especially keys) never reach a file */
const environmentDescription = (environment: ProbeEnvironment): readonly string[] => {
    const important = [
        'TEST_INSTANCE',
        'DB_PATH',
        'GEMINI_API_URL',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_CLOUD_LOCATION',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'OPENAI_API_URL',
        'ANTHROPIC_API_URL',
        'GROK_API_URL',
        'DEEPSEEK_API_URL',
        'MIMO_API_URL',
    ];
    return important.map((key) => `${key}=${(environment.values[key] ?? '') === '' ? '(unset)' : '(set)'}`);
};

const writeText = (outDir: string, name: string, content: string): string => {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, name);
    writeFileSync(path, content);
    return path;
};

const combinedPlanOf = (plans: readonly ProbePlan[], wave: ProbeWave | 'all'): ProbePlan => {
    const candidates = plans.flatMap((plan) => plan.candidates);
    const w1 = plans.filter((plan) => plan.wave === 'w1' || plan.wave === 'all').flatMap((plan) => plan.candidates.filter((candidate) => candidate.wave === 'w1'));
    const w2 = plans.filter((plan) => plan.wave === 'w2' || plan.wave === 'all').flatMap((plan) => plan.candidates.filter((candidate) => candidate.wave === 'w2'));
    const usdOf = (list: readonly ProbeCandidate[]): number => roundUsd(list.reduce((sum, candidate) => sum + candidate.estimatedCostUsd, 0));
    return {
        wave,
        models: plans[0]?.models ?? [],
        candidates,
        requests: candidates.length,
        estimatedUsd: usdOf(candidates),
        perWave: {
            w1: { requests: w1.length, estimatedUsd: usdOf(w1) },
            w2: { requests: w2.length, estimatedUsd: usdOf(w2) },
        },
        cut: plans.reduce<ProbePlan['cut']>(
            (merged, plan) => ({
                droppedRequests: merged.droppedRequests + plan.cut.droppedRequests,
                droppedUsd: roundUsd(merged.droppedUsd + plan.cut.droppedUsd),
                reasons: [...new Set([...merged.reasons, ...plan.cut.reasons])],
            }),
            { droppedRequests: 0, droppedUsd: 0, reasons: [] }
        ),
    };
};

/** Final attempts per candidate id, so W2 samples what W1 really accepted */
const acceptedEffortsFromObservations = (
    specs: readonly ProbeModelSpec[],
    observations: readonly ProbeObservation[]
): Record<string, readonly EffortValue[]> => {
    const result: Record<string, readonly EffortValue[]> = {};
    for (const spec of specs) {
        const summary = summarizeModel(spec, observations);
        if (summary.acceptedEfforts.length > 0 || TOGGLE_PLATFORMS.has(spec.platform)) {
            result[spec.model] = summary.acceptedEfforts;
        }
    }
    return result;
};

const skip = (state: RunnerState, candidate: ProbeCandidate, reason: string): void => {
    state.skipped.push({ candidateId: candidate.id, model: candidate.model, platform: candidate.platform, reason });
};

const logObservation = (log: (line: string) => void, observation: ProbeObservation, charged: number): void => {
    const outcome =
        observation.outcome === 'accepted'
            ? 'accepted'
            : observation.errorClass === null
              ? observation.outcome
              : `${observation.outcome}/${observation.errorClass}`;
    const tokens = observation.reasoningTokens === null ? 'n/a' : String(observation.reasoningTokens);
    log(
        `  ${observation.platform.padEnd(9)} ${observation.model.padEnd(30)} ${observation.variant.padEnd(13)} ${(observation.effort ?? 'auto').padEnd(8)} ${outcome.padEnd(20)} thoughts=${tokens.padStart(5)} ttfb=${observation.ttfbMs ?? 'n/a'}ms total=${observation.totalMs}ms $${charged.toFixed(6)}`
    );
    if (observation.errorSummary !== null && observation.outcome !== 'accepted') {
        log(`    ↳ ${observation.errorClass === null ? 'error' : errorClassLabel(observation.errorClass)}: ${observation.errorSummary.slice(0, 200)}`);
    }
};

interface SendAttemptResult {
    readonly observation: ProbeObservation;
    readonly charged: number;
}

/** One candidate, with the one allowed retry for transport-style failures */
const sendCandidate = async (input: {
    readonly options: ProbeRunOptions;
    readonly state: RunnerState;
    readonly candidate: ProbeCandidate;
    readonly spec: ProbeModelSpec;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly log: (line: string) => void;
}): Promise<SendAttemptResult | null> => {
    const { options, state, candidate, spec } = input;
    const lane = options.lanes[candidate.platform];
    let attempt = 0;
    for (;;) {
        if (state.requestCount + 1 > options.budget.maxRequests) {
            state.stoppedReason = `--max-requests ${options.budget.maxRequests} reached`;
            return null;
        }
        if (roundUsd(state.spentUsd + candidate.estimatedCostUsd) > options.budget.maxUsd) {
            state.stoppedReason = `--max-usd ${options.budget.maxUsd.toFixed(2)} reached`;
            return null;
        }
        attempt += 1;
        let observation: ProbeObservation;
        try {
            observation = await withRequestTimeout(options.budget.timeoutMs, options.signal, (signal) =>
                lane.send(candidate, { maxOutputTokens: tokenCapOf(candidate.wave, options.budget), timeoutMs: options.budget.timeoutMs, signal })
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            state.stoppedReason = `unexpected lane failure: ${message}`;
            return null;
        }
        state.requestCount += 1;
        observation = { ...observation, attempt };
        const charged = chargeOf(spec, observation);
        state.spentUsd = roundUsd(state.spentUsd + charged);
        const finalized = { ...observation, costUsd: charged };
        state.observations.push(finalized);
        logObservation(input.log, finalized, charged);
        if (options.signal?.aborted === true) {
            state.stoppedReason = 'interrupted';
            return { observation: finalized, charged };
        }
        const errorClass = finalized.errorClass;
        if (errorClass === 'auth_error') {
            state.stoppedReason = `auth_error on ${candidate.platform}`;
            return { observation: finalized, charged };
        }
        if (errorClass === 'model_missing') state.stoppedModels.add(candidate.model);
        if (errorClass === 'rate_limited') {
            const count = (state.lane429.get(candidate.platform) ?? 0) + 1;
            state.lane429.set(candidate.platform, count);
            state.lane5xx.set(candidate.platform, 0);
            if (count >= LANE_429_LIMIT) {
                state.stoppedLanes.add(candidate.platform);
                input.log(`  [circuit] ${candidate.platform}: ${count} consecutive 429s, lane stopped`);
            }
        } else if (errorClass === 'upstream_error') {
            const count = (state.lane5xx.get(candidate.platform) ?? 0) + 1;
            state.lane5xx.set(candidate.platform, count);
            state.lane429.set(candidate.platform, 0);
            if (count >= LANE_5XX_LIMIT) {
                state.stoppedLanes.add(candidate.platform);
                input.log(`  [circuit] ${candidate.platform}: ${count} consecutive 5xx, lane stopped`);
            }
        } else {
            state.lane429.set(candidate.platform, 0);
            state.lane5xx.set(candidate.platform, 0);
        }
        const retryable = errorClass !== null && RETRYABLE_CLASSES.has(errorClass);
        const retriesLeft = attempt <= options.budget.maxRetries;
        const laneUsable = !state.stoppedLanes.has(candidate.platform);
        if (!retryable || !retriesLeft || !laneUsable || state.stoppedReason !== null) {
            return { observation: finalized, charged };
        }
        state.retryCount += 1;
        input.log(`  [retry] ${candidate.id} after ${errorClass} (attempt ${attempt})`);
        await input.sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    }
};

/** Send every candidate in order; the first unfixable condition ends the run */
const processCandidates = async (input: {
    readonly options: ProbeRunOptions;
    readonly state: RunnerState;
    readonly candidates: readonly ProbeCandidate[];
    readonly specsByModel: ReadonlyMap<string, ProbeModelSpec>;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly log: (line: string) => void;
}): Promise<void> => {
    const { options, state } = input;
    for (const candidate of input.candidates) {
        if (state.stoppedReason !== null) return;
        if (options.signal?.aborted === true) {
            state.stoppedReason = 'interrupted';
            return;
        }
        const spec = input.specsByModel.get(candidate.model);
        if (spec === undefined) {
            skip(state, candidate, 'model is not in the plan snapshot');
            continue;
        }
        const lane = options.lanes[candidate.platform];
        if (!lane.ready) {
            skip(state, candidate, `lane not configured: ${lane.configuration.problems.join('; ')}`);
            continue;
        }
        if (state.stoppedLanes.has(candidate.platform)) {
            skip(state, candidate, 'lane stopped by a circuit breaker');
            continue;
        }
        if (state.stoppedModels.has(candidate.model)) {
            skip(state, candidate, 'model stopped earlier (model_missing)');
            continue;
        }
        const pacing =
            options.pacingMs === undefined
                ? { min: REQUEST_PACING_MIN_MS, max: REQUEST_PACING_MAX_MS }
                : options.pacingMs;
        if (pacing !== null) {
            const spread = pacing.max - pacing.min;
            await input.sleep(pacing.min + Math.round(Math.random() * spread));
        }
        const result = await sendCandidate({ ...input, candidate, spec });
        if (result === null) return;
    }
};

/** Build the run: dry-run prints and writes the plan; otherwise send the plan */
export const runProbe = async (rawOptions: ProbeRunOptions): Promise<ProbeRunOutcome> => {
    const options: ProbeRunOptions = { ...rawOptions, budget: clampBudget(rawOptions.budget) };
    const log = options.log ?? ((line: string): void => console.log(line));
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? ((): Date => new Date());
    const startedAt = now().toISOString();
    const laneSignature = laneSignatureOf(laneConfigurationsOf(options.lanes));

    if (options.dryRun) {
        const plan = buildProbePlan(planOptionsOf(options, options.wave, options.budget));
        log(`[probe] mode: dry-run (no request will be sent)`);
        log(`[probe] lane: ${laneSignature}`);
        log(formatPlanTable({ candidates: plan.candidates, estimatedUsd: plan.estimatedUsd }));
        if (plan.cut.droppedRequests > 0) {
            log(`[budget] dropped ${plan.cut.droppedRequests} candidates ($${plan.cut.droppedUsd.toFixed(4)}) because of ${plan.cut.reasons.join(', ')}`);
        }
        log(`[budget] worst case $${plan.estimatedUsd.toFixed(4)} of $${options.budget.maxUsd.toFixed(2)}; ${plan.requests} requests of ${options.budget.maxRequests}`);
        const finishedAt = now().toISOString();
        mkdirSync(options.outDir, { recursive: true });
        const files = [
            writeText(
                options.outDir,
                'plan.json',
                JSON.stringify(
                    {
                        schema: 1,
                        mode: 'dry-run',
                        generatedAt: startedAt,
                        laneSignature,
                        wave: options.wave,
                        budget: options.budget,
                        requests: plan.requests,
                        estimatedUsd: plan.estimatedUsd,
                        perWave: plan.perWave,
                        cut: plan.cut,
                        candidates: plan.candidates,
                    },
                    null,
                    2
                )
            ),
            writeText(
                options.outDir,
                'run.json',
                JSON.stringify(
                    {
                        schema: 1,
                        mode: 'dry-run',
                        startedAt,
                        finishedAt,
                        laneSignature,
                        wave: options.wave,
                        budget: options.budget,
                        requests: 0,
                        spentUsd: 0,
                        gates: options.gates,
                        environment: environmentDescription(options.environment),
                    },
                    null,
                    2
                )
            ),
        ];
        return {
            dryRun: true,
            stub: options.stub,
            laneSignature,
            plan,
            observations: [],
            skipped: [],
            summary: null,
            document: null,
            inferences: [],
            requestCount: 0,
            retryCount: 0,
            spentUsd: 0,
            stoppedReason: null,
            files,
            startedAt,
            finishedAt,
        };
    }

    const state = createRunnerState();
    const plans: ProbePlan[] = [];
    let summary: ProbeRunSummary | null = null;
    let specsUsed: readonly ProbeModelSpec[] = [];

    if (options.wave === 'w1' || options.wave === 'all') {
        const w1Plan = buildProbePlan(planOptionsOf(options, 'w1', options.budget));
        plans.push(w1Plan);
        specsUsed = w1Plan.models;
        const specsByModel = new Map(w1Plan.models.map((spec) => [spec.model, spec]));
        log(`[probe] W1: ${w1Plan.requests} requests, worst case $${w1Plan.estimatedUsd.toFixed(4)}`);
        await processCandidates({
            options,
            state,
            candidates: w1Plan.candidates,
            specsByModel,
            sleep,
            log,
        });
        if (options.wave === 'all' && state.stoppedReason === null && options.signal?.aborted !== true) {
            const acceptedEffortsByModel = acceptedEffortsFromObservations(w1Plan.models, state.observations);
            const remainingBudget = clampBudget({
                maxRequests: Math.max(1, options.budget.maxRequests - state.requestCount),
                maxUsd: Math.max(0.01, roundUsd(options.budget.maxUsd - state.spentUsd)),
                timeoutMs: options.budget.timeoutMs,
                maxRetries: options.budget.maxRetries,
            });
            const w2Plan = buildProbePlan({
                ...planOptionsOf(options, 'w2', remainingBudget),
                acceptedEffortsByModel,
            });
            plans.push(w2Plan);
            const w2SpecsByModel = new Map(w2Plan.models.map((spec) => [spec.model, spec]));
            log(`[probe] W2: ${w2Plan.requests} requests, worst case $${w2Plan.estimatedUsd.toFixed(4)}`);
            await processCandidates({
                options,
                state,
                candidates: w2Plan.candidates,
                specsByModel: w2SpecsByModel,
                sleep,
                log,
            });
        }
    } else {
        const w2Plan = buildProbePlan(planOptionsOf(options, 'w2', options.budget));
        plans.push(w2Plan);
        specsUsed = w2Plan.models;
        log(`[probe] W2: ${w2Plan.requests} requests, worst case $${w2Plan.estimatedUsd.toFixed(4)}`);
        await processCandidates({
            options,
            state,
            candidates: w2Plan.candidates,
            specsByModel: new Map(w2Plan.models.map((spec) => [spec.model, spec])),
            sleep,
            log,
        });
    }

    const combinedPlan = combinedPlanOf(plans, options.wave);
    const finishedAt = now().toISOString();
    const summarySpecs = options.modelSpecs === undefined ? specsUsed : options.modelSpecs;
    const acceptedEffortsByModel = options.acceptedEffortsByModel ?? {};
    summary = buildRunSummary({
        probedAt: startedAt,
        laneSignature,
        specs: summarySpecs,
        observations: state.observations,
        acceptedEffortsByModel,
    });
    const files = writeRunFiles({
        options,
        laneSignature,
        startedAt,
        finishedAt,
        plan: combinedPlan,
        state,
        summary,
    });
    log('');
    log(`[probe] done: ${state.requestCount} requests, ${state.retryCount} retries, $${state.spentUsd.toFixed(4)} spent`);
    log(`[probe] importable models: ${summary.document.results.length}${summary.incomplete.length > 0 ? `, incomplete: ${summary.incomplete.map((inference) => inference.spec.model).join(', ')}` : ''}`);
    if (state.skipped.length > 0) {
        const reasons = [...new Set(state.skipped.map((entry) => entry.reason))];
        log(`[probe] not sent: ${state.skipped.length} candidates (${reasons.join('; ')})`);
    }
    if (state.stoppedReason !== null) log(`[probe] stopped: ${state.stoppedReason}`);
    log(`[probe] files: ${files.join(', ')}`);
    return {
        dryRun: false,
        stub: options.stub,
        laneSignature,
        plan: combinedPlan,
        observations: state.observations,
        skipped: state.skipped,
        summary,
        document: summary.document,
        inferences: summary.inferences,
        requestCount: state.requestCount,
        retryCount: state.retryCount,
        spentUsd: state.spentUsd,
        stoppedReason: state.stoppedReason,
        files,
        startedAt,
        finishedAt,
    };
};

interface WriteRunFilesInput {
    readonly options: ProbeRunOptions;
    readonly laneSignature: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly plan: ProbePlan;
    readonly state: RunnerState;
    readonly summary: ProbeRunSummary;
}

/** The run's artifacts: plan, raw evidence, importable document, readable summary */
const writeRunFiles = (input: WriteRunFilesInput): readonly string[] => {
    const { options, state, summary } = input;
    const files: string[] = [];
    files.push(
        writeText(
            options.outDir,
            'plan.json',
            JSON.stringify(
                {
                    schema: 1,
                    mode: options.stub ? 'stub' : 'live',
                    generatedAt: input.startedAt,
                    laneSignature: input.laneSignature,
                    wave: options.wave,
                    budget: options.budget,
                    requests: input.plan.requests,
                    estimatedUsd: input.plan.estimatedUsd,
                    perWave: input.plan.perWave,
                    cut: input.plan.cut,
                    candidates: input.plan.candidates,
                },
                null,
                2
            )
        )
    );
    files.push(
        writeText(
            options.outDir,
            'results.json',
            JSON.stringify(summary.document, null, 2)
        )
    );
    files.push(
        writeText(
            options.outDir,
            'observations.json',
            JSON.stringify(
                {
                    schema: 1,
                    generatedAt: input.startedAt,
                    finishedAt: input.finishedAt,
                    laneSignature: input.laneSignature,
                    requests: state.requestCount,
                    retries: state.retryCount,
                    spentUsd: roundUsd(state.spentUsd),
                    stoppedReason: state.stoppedReason,
                    skipped: state.skipped,
                    inferences: summary.inferences.map((inference) => ({
                        model: inference.spec.model,
                        acceptedEfforts: inference.acceptedEfforts,
                        mappedEfforts: inference.mappedEfforts,
                        inertEfforts: inference.inertEfforts,
                        toggle: inference.toggle,
                        defaultInference: inference.defaultInference,
                        incomplete: inference.incomplete,
                        incompleteReasons: inference.incompleteReasons,
                        rejected: inference.rejected.map((observation) => ({
                            candidateId: observation.candidateId,
                            effort: observation.effort,
                            variant: observation.variant,
                            errorClass: observation.errorClass,
                            errorSummary: observation.errorSummary,
                        })),
                        samples: inference.w2Observations.map((observation) => ({
                            candidateId: observation.candidateId,
                            effort: observation.effort,
                            variant: observation.variant,
                            reasoningTokens: observation.reasoningTokens,
                            ttfbMs: observation.ttfbMs,
                            totalMs: observation.totalMs,
                            finishReason: observation.finishReason,
                        })),
                    })),
                    observations: state.observations,
                },
                null,
                2
            )
        )
    );
    files.push(
        writeText(
            options.outDir,
            'summary.md',
            formatSummaryMarkdown({
                probedAt: summary.probedAt,
                laneSignature: input.laneSignature,
                budgetUsd: options.budget.maxUsd,
                spentUsd: state.spentUsd,
                summary,
                errors: state.observations.filter((observation) => observation.errorClass !== null),
                startedAt: input.startedAt,
                finishedAt: input.finishedAt,
                skipped: state.skipped.map((entry) => ({ candidateId: entry.candidateId, reason: entry.reason })),
            })
        )
    );
    files.push(
        writeText(
            options.outDir,
            'run.json',
            JSON.stringify(
                {
                    schema: 1,
                    mode: options.stub ? 'stub' : 'live',
                    startedAt: input.startedAt,
                    finishedAt: input.finishedAt,
                    laneSignature: input.laneSignature,
                    wave: options.wave,
                    budget: options.budget,
                    requests: state.requestCount,
                    retries: state.retryCount,
                    spentUsd: roundUsd(state.spentUsd),
                    stoppedReason: state.stoppedReason,
                    gates: options.gates,
                    lanes: Object.values(options.lanes).map((lane) => ({
                        platform: lane.platform,
                        laneId: lane.configuration.laneId,
                        ready: lane.ready,
                        problems: lane.configuration.problems,
                    })),
                    environment: environmentDescription(options.environment),
                },
                null,
                2
            )
        )
    );
    return files;
};
