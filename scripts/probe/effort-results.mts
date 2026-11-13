/**
 * From raw observations to the one artifact the owner imports.
 *
 * `results.json` follows design §7 exactly, so `/probe import` can whitelist it
 * without a version dance. The reasoning behind each row (which values were
 * rejected and why, what the effect samples looked like, which model had an
 * incomplete matrix) goes to `observations.json` and `summary.md` instead.
 *
 * An incomplete model row is left out on purpose: a model that only answered
 * half its candidates would otherwise publish a truncated `acceptedEfforts`
 * list, and the import would shrink the product's menu.
 */
import {
    EFFORT_LABELS,
    ERROR_SUMMARY_LIMIT,
    effortRank,
    isEffortValue,
    sortEfforts,
    type EffortValue,
    type ProbeCandidate,
    type ProbeModelSpec,
    type ProbeObservation,
    type ProbeResultDocument,
    type ProbeResultEntry,
    type ProbeWave,
    type ProbeWireOutcome,
    type ValidationResult,
} from './effort-types.mts';
import { errorClassLabel, isRejectionClass } from './effort-errors.mts';
import { isTokenCapFinishReason } from './effort-wire.mts';

/** DeepSeek and MiMo expose on/off instead of graded efforts */
const TOGGLE_PLATFORMS = new Set(['deepseek', 'mimo']);

/** Worst case the runner reserves before a request; actual usage replaces it */
export const billedCostUsd = (spec: ProbeModelSpec, observation: ProbeObservation): number => {
    const output = observation.outputTokens ?? observation.reasoningTokens;
    if (observation.inputTokens === null && output === null) return observation.estimatedCostUsd;
    const input = observation.inputTokens ?? 0;
    const usd =
        (input * spec.price.inputPerMillionUsd + (output ?? 0) * spec.price.outputPerMillionUsd) / 1_000_000;
    return Math.round(usd * 1_000_000) / 1_000_000;
};

/** The label of one candidate in the error summary (design §7 example: "minimal") */
export const candidateLabelOf = (candidate: ProbeCandidate): string => {
    switch (candidate.variant) {
        case 'level':
            return candidate.effort ?? 'level';
        case 'budget':
            return 'thinkingBudget:-1';
        case 'toggle-on':
            return 'thinking:enabled';
        case 'toggle-off':
            return 'thinking:disabled';
        case 'invalid-shape':
            return 'thinking.type:low';
        case 'baseline':
            return 'baseline';
    }
};

/** A candidate view of an observation, for labels and error summaries */
export const candidateOfObservation = (observation: ProbeObservation): ProbeCandidate => ({
    id: observation.candidateId,
    model: observation.model,
    platform: observation.platform,
    wave: observation.wave,
    variant: observation.variant,
    effort: observation.effort,
    withClientTools: observation.withClientTools,
    ...(observation.expectedRejection === null ? {} : { expectedRejection: observation.expectedRejection }),
    repeats: 1,
    estimatedCostUsd: observation.estimatedCostUsd,
});

/**
 * True when the probe's own output cap ended the sample, so its token count is
 * a floor and must not compete with the other W2 samples. The lane records the
 * flag in observations.json; the wire finish reason is authoritative here, so a
 * hand-built fixture or an older evidence file classifies the same way.
 */
export const truncatedOf = (observation: ProbeObservation): boolean => isTokenCapFinishReason(observation.finishReason);

/** The effect samples that a probe cap did not cut */
const untruncatedOf = (observations: readonly ProbeObservation[]): ProbeObservation[] =>
    observations.filter((observation) => !truncatedOf(observation));

/** Candidates whose final attempt proves the model matrix is not trustworthy */
const UNRELIABLE_CLASSES: ReadonlySet<string> = new Set([
    'auth_error',
    'model_missing',
    'lane_error',
    'rate_limited',
    'upstream_error',
    'network_error',
]);

export type DefaultEffortSource = 'probe-effect' | 'vendor' | 'unknown';

export interface EffectSample {
    readonly label: string;
    readonly wave: ProbeWave;
    readonly reasoningTokens: number | null;
    readonly ttfbMs: number | null;
    readonly totalMs: number | null;
}

export interface DefaultEffortInference {
    readonly defaultEffort: EffortValue | null;
    readonly source: DefaultEffortSource;
    readonly confidence: 'high' | 'medium' | 'low';
    readonly detail: string;
    readonly baselineReasoningTokens: number | null;
    /** W2 samples the probe's own token cap cut; they are excluded from the match */
    readonly truncatedSamples: number;
}

const medianOf = (values: readonly number[]): number | null => {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    const value = sorted[middle];
    if (value === undefined) return null;
    if (sorted.length % 2 === 1) return value;
    const lower = sorted[middle - 1];
    return lower === undefined ? value : (lower + value) / 2;
};

const reasoningTokensOf = (observations: readonly ProbeObservation[]): number[] =>
    observations
        .filter((observation) => observation.outcome === 'accepted')
        .map((observation) => observation.reasoningTokens ?? 0);

const ratioOf = (value: number, reference: number): number => Math.log((value + 1) / (reference + 1));

/**
 * Infer the vendor default effort from W2: the baseline (no explicit effort)
 * should sit closest to the level the vendor really uses. No separation means
 * no answer — the product must show "vendor default" rather than a guess.
 */
export const inferDefaultEffort = (w2Observations: readonly ProbeObservation[]): DefaultEffortInference => {
    // A capped sample says nothing about the effort (its thought count is a
    // floor), so it neither sets the baseline nor competes as a level.
    const truncatedSamples = w2Observations.filter(truncatedOf).length;
    const ignored = truncatedSamples === 0 ? '' : `; ignored ${truncatedSamples} truncated sample(s)`;
    const usable = untruncatedOf(w2Observations);
    const baselineSamples = usable.filter((observation) => observation.wave === 'w2' && observation.variant === 'baseline');
    const baseline = medianOf(reasoningTokensOf(baselineSamples));
    if (baseline === null) {
        return {
            defaultEffort: null,
            source: 'unknown',
            confidence: 'low',
            detail: `no usable W2 baseline samples${ignored}`,
            baselineReasoningTokens: null,
            truncatedSamples,
        };
    }
    const groups = new Map<EffortValue, ProbeObservation[]>();
    for (const observation of usable) {
        if (observation.wave !== 'w2' || observation.variant !== 'level' || observation.effort === null) continue;
        const list = groups.get(observation.effort) ?? [];
        list.push(observation);
        groups.set(observation.effort, list);
    }
    const distances: Array<{ effort: EffortValue; median: number; distance: number }> = [];
    for (const [effort, observations] of groups) {
        if (!isEffortValue(effort)) continue;
        const median = medianOf(reasoningTokensOf(observations));
        if (median === null) continue;
        distances.push({ effort, median, distance: Math.abs(ratioOf(median, baseline)) });
    }
    distances.sort((left, right) => left.distance - right.distance);
    const nearest = distances[0];
    const second = distances[1];
    if (nearest === undefined) {
        return {
            defaultEffort: null,
            source: 'unknown',
            confidence: 'low',
            detail: `no W2 effort samples with token usage${ignored}`,
            baselineReasoningTokens: baseline,
            truncatedSamples,
        };
    }
    const separation = second === undefined ? Number.POSITIVE_INFINITY : second.distance - nearest.distance;
    const sampleCount = (groups.get(nearest.effort) ?? []).length;
    const enoughSamples = sampleCount >= 2;
    const closeEnough = nearest.distance <= Math.log(1.25);
    const separated = separation >= Math.log(1.1);
    if (enoughSamples && closeEnough && separated) {
        return {
            defaultEffort: nearest.effort,
            source: 'probe-effect',
            confidence: 'high',
            detail: `baseline leads to ${nearest.effort} (Δ=${nearest.distance.toFixed(2)}, gap=${separation.toFixed(2)})${ignored}`,
            baselineReasoningTokens: baseline,
            truncatedSamples,
        };
    }
    return {
        defaultEffort: null,
        source: 'unknown',
        confidence: 'low',
        detail:
            nearest === undefined
                ? `no usable samples${ignored}`
                : `no clear match (nearest ${nearest.effort}, Δ=${nearest.distance.toFixed(2)}, gap=${separation === Number.POSITIVE_INFINITY ? 'n/a' : separation.toFixed(2)}, samples=${sampleCount})${ignored}`,
        baselineReasoningTokens: baseline,
        truncatedSamples,
    };
};

/**
 * Accepted efforts W2 shows to be without effect. A sample of the vendor
 * default looks "equal to the baseline" by construction, so it is not inert;
 * only another effort that thinks no more than the baseline counts.
 */
export const inertEffortsOf = (
    spec: ProbeModelSpec,
    w2Observations: readonly ProbeObservation[]
): EffortValue[] => {
    // Same rule as the default inference: a capped sample is a floor, not a
    // measurement, so it can neither establish nor prove "no effect".
    const usable = untruncatedOf(w2Observations);
    const baseline = medianOf(reasoningTokensOf(usable.filter((observation) => observation.variant === 'baseline')));
    if (baseline === null || baseline === 0) return [];
    const inert: EffortValue[] = [];
    const groups = new Map<EffortValue, number[]>();
    for (const observation of usable) {
        if (observation.variant !== 'level' || observation.effort === null) continue;
        const values = groups.get(observation.effort) ?? [];
        values.push(observation.reasoningTokens ?? 0);
        groups.set(observation.effort, values);
    }
    for (const [effort, values] of groups) {
        if (effort === spec.vendorDefaultEffort) continue;
        const median = medianOf(values);
        if (median === null) continue;
        if (median / baseline < 1.15) inert.push(effort);
    }
    return sortEfforts(inert);
};

export interface ModelInference {
    readonly spec: ProbeModelSpec;
    readonly w1Observations: readonly ProbeObservation[];
    readonly w2Observations: readonly ProbeObservation[];
    readonly acceptedEfforts: readonly EffortValue[];
    /** Accepted values outside the vendor list: the lane maps them to another level */
    readonly mappedEfforts: readonly EffortValue[];
    readonly inertEfforts: readonly EffortValue[];
    /** W2 samples the probe's own token cap cut (excluded from effect evidence) */
    readonly truncatedSamples: number;
    readonly defaultInference: DefaultEffortInference;
    readonly toggle: boolean;
    readonly errorSummary: Readonly<Record<string, string>>;
    readonly incomplete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly rejected: readonly ProbeObservation[];
}

const summarizeModelInner = (spec: ProbeModelSpec, observations: readonly ProbeObservation[]): ModelInference => {
    const w1 = observations.filter((observation) => observation.wave === 'w1' && observation.model === spec.model);
    const w2 = observations.filter((observation) => observation.wave === 'w2' && observation.model === spec.model);
    const finalW1 = new Map<string, ProbeObservation>();
    for (const observation of w1) {
        const previous = finalW1.get(observation.candidateId);
        if (previous === undefined || observation.attempt >= previous.attempt) finalW1.set(observation.candidateId, observation);
    }

    const incompleteReasons: string[] = [];
    const rejected: ProbeObservation[] = [];
    const acceptedLevels: EffortValue[] = [];
    const vendorSet = new Set(spec.vendorEfforts);
    let baselineAccepted = false;
    let toggleOffAccepted: boolean | null = null;

    for (const observation of finalW1.values()) {
        const candidate = candidateOfObservation(observation);
        const label = candidateLabelOf(candidate);
        if (observation.outcome === 'accepted') {
            if (observation.variant === 'baseline') baselineAccepted = true;
            else if (observation.variant === 'level' && observation.effort !== null) acceptedLevels.push(observation.effort);
            else if (observation.variant === 'toggle-off') toggleOffAccepted = true;
            continue;
        }
        // A rejected client-tool fidelity variant is diagnostic only: the
        // product's chat rounds may combine tools and levels, but a rejection
        // there must not hide the plain acceptance matrix.
        if (candidate.withClientTools) continue;
        const errorClass = observation.errorClass ?? 'unclassified';
        if (UNRELIABLE_CLASSES.has(errorClass)) {
            incompleteReasons.push(`${label}: ${errorClass}`);
            continue;
        }
        rejected.push(observation);
        // A level the vendor list does not even name is a diagnostic probe, not
        // a required shape: its rejection must not hide the vendor levels that
        // did answer (e.g. OpenAI's `none` on a model whose vendor list starts
        // at `low`).
        const diagnosticOutOfVendor =
            observation.variant === 'level' &&
            candidate.effort !== null &&
            spec.vendorEfforts.length > 0 &&
            !vendorSet.has(candidate.effort);
        // A required request shape that was rejected without a clear effort
        // fingerprint leaves no trustworthy answer for this model.
        const required =
            candidate.expectedRejection === undefined &&
            !diagnosticOutOfVendor &&
            (observation.variant === 'baseline' || observation.variant === 'level' || observation.variant === 'toggle-off' || observation.variant === 'toggle-on');
        if (required && errorClass !== 'rejected_effort') {
            incompleteReasons.push(`${label}: ${errorClass}`);
        }
    }
    if (finalW1.size === 0) incompleteReasons.push('no W1 observations');
    if (!baselineAccepted && finalW1.size > 0) incompleteReasons.push('baseline was not accepted');

    const acceptedEfforts = sortEfforts(acceptedLevels.filter((effort) => vendorSet.has(effort)));
    const mappedEfforts = sortEfforts(acceptedLevels.filter((effort) => !vendorSet.has(effort) && spec.vendorEfforts.length > 0));
    const defaultInference = inferDefaultEffort(w2);
    const toggle = TOGGLE_PLATFORMS.has(spec.platform) && toggleOffAccepted !== null ? toggleOffAccepted : spec.vendorToggle;

    const errorSummary: Record<string, string> = {};
    for (const observation of rejected) {
        if (observation.errorSummary === null) continue;
        const label = candidateLabelOf(candidateOfObservation(observation));
        if (errorSummary[label] === undefined) errorSummary[label] = observation.errorSummary;
    }

    return {
        spec,
        w1Observations: w1,
        w2Observations: w2,
        acceptedEfforts,
        mappedEfforts,
        inertEfforts: inertEffortsOf(spec, w2),
        truncatedSamples: w2.filter(truncatedOf).length,
        defaultInference,
        toggle,
        errorSummary,
        incomplete: incompleteReasons.length > 0,
        incompleteReasons,
        rejected,
    };
};

/** One model's row plus the reasoning behind it */
export const summarizeModel = (spec: ProbeModelSpec, observations: readonly ProbeObservation[]): ModelInference =>
    summarizeModelInner(spec, observations);

export interface ProbeRunSummary {
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly checkedOn: string;
    readonly document: ProbeResultDocument;
    readonly inferences: readonly ModelInference[];
    /** Models left out of the document and why */
    readonly incomplete: readonly ModelInference[];
}

export const checkedOnOf = (probedAt: string): string => probedAt.slice(0, 10);

/**
 * Build the §7 document. Only complete W1 matrices enter it; W2 is optional
 * (a W1-only run still yields accepted efforts and the vendor default).
 */
export const buildRunSummary = (input: {
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly specs: readonly ProbeModelSpec[];
    readonly observations: readonly ProbeObservation[];
    /** A W2-only run refines defaults for the accepted set of an earlier run */
    readonly acceptedEffortsByModel?: Readonly<Record<string, readonly EffortValue[]>>;
}): ProbeRunSummary => {
    const w1Models = new Set(
        input.observations.filter((observation) => observation.wave === 'w1').map((observation) => observation.model)
    );
    const inferences: ModelInference[] = [];
    for (const spec of input.specs) {
        if (!input.observations.some((observation) => observation.model === spec.model)) continue;
        if (w1Models.has(spec.model)) {
            inferences.push(summarizeModel(spec, input.observations));
            continue;
        }
        const accepted = input.acceptedEffortsByModel?.[spec.model];
        if (accepted === undefined) continue;
        const w2 = input.observations.filter((observation) => observation.model === spec.model && observation.wave === 'w2');
        inferences.push({
            spec,
            w1Observations: [],
            w2Observations: w2,
            acceptedEfforts: sortEfforts(accepted),
            mappedEfforts: [],
            inertEfforts: inertEffortsOf(spec, w2),
            truncatedSamples: w2.filter(truncatedOf).length,
            defaultInference: inferDefaultEffort(w2),
            toggle: spec.vendorToggle,
            errorSummary: {},
            incomplete: false,
            incompleteReasons: [],
            rejected: [],
        });
    }
    const complete = inferences.filter((inference) => !inference.incomplete);
    const checkedOn = checkedOnOf(input.probedAt);
    const results: ProbeResultEntry[] = complete.map((inference) => ({
        model: inference.spec.model,
        acceptedEfforts: inference.acceptedEfforts,
        defaultEffort:
            inference.defaultInference.source === 'probe-effect'
                ? inference.defaultInference.defaultEffort
                : inference.spec.vendorDefaultEffort,
        toggle: inference.toggle,
        errorSummary: inference.errorSummary,
        checkedOn,
    }));
    return {
        probedAt: input.probedAt,
        laneSignature: input.laneSignature,
        checkedOn,
        document: { schema: 1, probedAt: input.probedAt, laneSignature: input.laneSignature, results },
        inferences,
        incomplete: inferences.filter((inference) => inference.incomplete),
    };
};

// ---------------------------------------------------------------------------
// Schema validation (what `/probe import` needs from us)
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const pushProblem = (problems: string[], message: string): void => {
    problems.push(message);
};

const validateEntry = (value: unknown, index: number, problems: string[]): void => {
    if (!isRecord(value)) {
        pushProblem(problems, `results[${index}] is not an object`);
        return;
    }
    if (typeof value['model'] !== 'string' || value['model'] === '') pushProblem(problems, `results[${index}].model is not a non-empty string`);
    const accepted = value['acceptedEfforts'];
    if (!Array.isArray(accepted)) {
        pushProblem(problems, `results[${index}].acceptedEfforts is not an array`);
    } else {
        const seen = new Set<string>();
        accepted.forEach((effort, position) => {
            if (typeof effort !== 'string' || !isEffortValue(effort)) {
                pushProblem(problems, `results[${index}].acceptedEfforts[${position}] is not a closed-set effort`);
                return;
            }
            if (seen.has(effort)) pushProblem(problems, `results[${index}].acceptedEfforts[${position}] is duplicated`);
            seen.add(effort);
        });
    }
    const defaultEffort = value['defaultEffort'];
    if (defaultEffort !== null && (typeof defaultEffort !== 'string' || !isEffortValue(defaultEffort))) {
        pushProblem(problems, `results[${index}].defaultEffort is neither null nor a closed-set effort`);
    }
    if (typeof value['toggle'] !== 'boolean') pushProblem(problems, `results[${index}].toggle is not a boolean`);
    const errorSummary = value['errorSummary'];
    if (!isRecord(errorSummary)) {
        pushProblem(problems, `results[${index}].errorSummary is not an object`);
    } else {
        for (const [label, message] of Object.entries(errorSummary)) {
            if (typeof message !== 'string') pushProblem(problems, `results[${index}].errorSummary.${label} is not a string`);
            else if (message.length > ERROR_SUMMARY_LIMIT) {
                pushProblem(problems, `results[${index}].errorSummary.${label} is longer than ${ERROR_SUMMARY_LIMIT} characters`);
            }
        }
    }
    const checkedOn = value['checkedOn'];
    if (typeof checkedOn !== 'string' || !DATE_PATTERN.test(checkedOn) || Number.isNaN(Date.parse(checkedOn))) {
        pushProblem(problems, `results[${index}].checkedOn is not a YYYY-MM-DD date`);
    }
};

/**
 * Validate an import document. Unknown keys are ignored (design §7: the owner
 * may annotate a file), known keys are checked strictly. Never throws.
 */
export const validateProbeDocument = (value: unknown): ValidationResult => {
    const problems: string[] = [];
    if (!isRecord(value)) {
        return { valid: false, errors: ['the document is not a JSON object'], document: null };
    }
    if (value['schema'] !== 1) pushProblem(problems, 'schema must be 1');
    const probedAt = value['probedAt'];
    if (typeof probedAt !== 'string' || probedAt === '' || Number.isNaN(Date.parse(probedAt))) {
        pushProblem(problems, 'probedAt is not an ISO timestamp');
    }
    const laneSignature = value['laneSignature'];
    if (typeof laneSignature !== 'string' || laneSignature === '') pushProblem(problems, 'laneSignature is not a non-empty string');
    const results = value['results'];
    if (!Array.isArray(results)) {
        pushProblem(problems, 'results is not an array');
    } else {
        results.forEach((entry, index) => validateEntry(entry, index, problems));
    }
    if (problems.length > 0) return { valid: false, errors: problems, document: null };
    // The shapes were checked field by field above; rebuild the typed document
    const entries: unknown[] = Array.isArray(results) ? results : [];
    const document: ProbeResultDocument = {
        schema: 1,
        probedAt: String(probedAt),
        laneSignature: String(laneSignature),
        results: entries.map((entry): ProbeResultEntry => {
            const record = isRecord(entry) ? entry : {};
            const accepted = Array.isArray(record['acceptedEfforts']) ? record['acceptedEfforts'] : [];
            const defaultEffort = record['defaultEffort'];
            const errorSummary = isRecord(record['errorSummary']) ? record['errorSummary'] : {};
            return {
                model: String(record['model']),
                acceptedEfforts: accepted.filter((effort): effort is EffortValue => typeof effort === 'string' && isEffortValue(effort)),
                defaultEffort:
                    typeof defaultEffort === 'string' && isEffortValue(defaultEffort) ? defaultEffort : null,
                toggle: record['toggle'] === true,
                errorSummary: Object.fromEntries(
                    Object.entries(errorSummary).filter((entryPair): entryPair is [string, string] => typeof entryPair[1] === 'string')
                ),
                checkedOn: String(record['checkedOn']),
            };
        }),
    };
    return { valid: true, errors: [], document };
};

/** Parse for W2's `--from-results`; returns the accepted efforts per model */
export const acceptedEffortsFromDocument = (
    document: ProbeResultDocument
): Record<string, readonly EffortValue[]> => {
    const result: Record<string, readonly EffortValue[]> = {};
    for (const entry of document.results) result[entry.model] = sortEfforts(entry.acceptedEfforts);
    return result;
};

// ---------------------------------------------------------------------------
// Human-readable tables
// ---------------------------------------------------------------------------

const sortedEffortsText = (efforts: readonly EffortValue[]): string =>
    sortEfforts(efforts)
        .map((effort) => EFFORT_LABELS[effort])
        .join('/');

/** One-line plan row: candidate count and worst-case cost per platform */
export const formatPlanTable = (input: {
    readonly candidates: readonly ProbeCandidate[];
    readonly estimatedUsd: number;
}): string => {
    const lines: string[] = [];
    const byPlatform = new Map<string, { requests: number; usd: number; w1: number; w2: number }>();
    for (const candidate of input.candidates) {
        const entry = byPlatform.get(candidate.platform) ?? { requests: 0, usd: 0, w1: 0, w2: 0 };
        entry.requests += 1;
        entry.usd += candidate.estimatedCostUsd;
        entry[candidate.wave] += 1;
        byPlatform.set(candidate.platform, entry);
    }
    lines.push('platform   records  W1  W2   worst-case USD');
    for (const [platform, entry] of [...byPlatform.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        lines.push(
            `${platform.padEnd(10)} ${String(entry.requests).padStart(7)}  ${String(entry.w1).padStart(2)}  ${String(entry.w2).padStart(2)}   $${entry.usd.toFixed(4)}`
        );
    }
    lines.push(`total      ${String(input.candidates.length).padStart(7)}       worst-case $${input.estimatedUsd.toFixed(4)}`);
    return lines.join('\n');
};

const effectLines = (inference: ModelInference): string[] => {
    if (inference.w2Observations.length === 0) return [];
    // Capped samples are floors, so they do not enter the medians; the line
    // still says how many were dropped.
    const usable = untruncatedOf(inference.w2Observations);
    const baseline = usable.filter((observation) => observation.variant === 'baseline');
    const baselineMedian = medianOf(reasoningTokensOf(baseline));
    const samples: EffectSample[] = [];
    const byEffort = new Map<string, ProbeObservation[]>();
    for (const observation of usable) {
        const label = candidateLabelOf(candidateOfObservation(observation));
        const list = byEffort.get(label) ?? [];
        list.push(observation);
        byEffort.set(label, list);
    }
    for (const [label, observations] of byEffort) {
        samples.push({
            label,
            wave: 'w2',
            reasoningTokens: medianOf(reasoningTokensOf(observations)),
            ttfbMs: medianOf(observations.map((observation) => observation.ttfbMs ?? 0)),
            totalMs: medianOf(observations.map((observation) => observation.totalMs)),
        });
    }
    const lines = [`  W2 baseline thoughts ${baselineMedian === null ? 'n/a' : Math.round(baselineMedian)}`];
    for (const sample of samples.sort((left, right) => effortRank(left.label) - effortRank(right.label))) {
        const ratio = baselineMedian === null || baselineMedian === 0 || sample.reasoningTokens === null ? null : sample.reasoningTokens / baselineMedian;
        lines.push(
            `  ${sample.label.padEnd(10)} thoughts=${sample.reasoningTokens === null ? 'n/a' : Math.round(sample.reasoningTokens)} ratio=${ratio === null ? 'n/a' : ratio.toFixed(2)} ttfb=${sample.ttfbMs ?? 'n/a'}ms total=${sample.totalMs ?? 'n/a'}ms`
        );
    }
    if (inference.truncatedSamples > 0) {
        lines.push(`  truncated samples ignored: ${inference.truncatedSamples} (probe token cap)`);
    }
    return lines;
};

/** summary.md: the owner reads this before importing */
export const formatSummaryMarkdown = (input: {
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly budgetUsd: number;
    readonly spentUsd: number;
    readonly summary: ProbeRunSummary;
    readonly errors: readonly ProbeObservation[];
    readonly startedAt: string;
    readonly finishedAt: string;
    /** Candidates the run never sent (budget stop, unconfigured lane, breaker) */
    readonly skipped?: readonly { readonly candidateId: string; readonly reason: string }[];
}): string => {
    const lines: string[] = [];
    lines.push('# Thinking-effort probe');
    lines.push('');
    lines.push(`- started: ${input.startedAt}`);
    lines.push(`- finished: ${input.finishedAt}`);
    lines.push(`- lane: \`${input.laneSignature}\``);
    lines.push(`- cost: $${input.spentUsd.toFixed(4)} of $${input.budgetUsd.toFixed(2)} budget`);
    lines.push(`- importable models: ${input.summary.document.results.length}`);
    const truncatedSamples = input.summary.inferences.reduce((sum, inference) => sum + inference.truncatedSamples, 0);
    if (truncatedSamples > 0) {
        lines.push(`- truncated W2 samples: ${truncatedSamples} (excluded from the default-effort and inert inference)`);
    }
    lines.push('');
    lines.push('## Models');
    lines.push('');
    lines.push('| model | accepted (probe) | vendor efforts | default | toggle | mapped | notes |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const inference of input.summary.inferences) {
        const notes: string[] = [];
        if (inference.incomplete) notes.push(`INCOMPLETE: ${inference.incompleteReasons.join('; ')}`);
        if (inference.inertEfforts.length > 0) notes.push(`inert: ${sortedEffortsText(inference.inertEfforts)}`);
        if (inference.truncatedSamples > 0) notes.push(`truncated: ${inference.truncatedSamples}`);
        const defaultText =
            inference.defaultInference.source === 'probe-effect'
                ? `${inference.defaultInference.defaultEffort} (probe)`
                : `${inference.spec.vendorDefaultEffort ?? 'unknown'} (vendor)`;
        lines.push(
            `| ${inference.spec.model} | ${sortedEffortsText(inference.acceptedEfforts) || '—'} | ${sortedEffortsText(inference.spec.vendorEfforts) || '—'} | ${defaultText} | ${inference.toggle ? 'yes' : 'no'} | ${sortedEffortsText(inference.mappedEfforts) || '—'} | ${notes.join(' / ') || ''} |`
        );
        for (const line of effectLines(inference)) lines.push(line);
    }
    if (input.summary.incomplete.length > 0) {
        lines.push('');
        lines.push('## Left out of results.json');
        for (const inference of input.summary.incomplete) {
            lines.push(`- ${inference.spec.model}: ${inference.incompleteReasons.join('; ')}`);
        }
    }
    if (input.skipped !== undefined && input.skipped.length > 0) {
        lines.push('');
        lines.push('## Not sent');
        const reasons = new Map<string, number>();
        for (const skipped of input.skipped) reasons.set(skipped.reason, (reasons.get(skipped.reason) ?? 0) + 1);
        for (const [reason, count] of reasons) lines.push(`- ${reason}: ${count}`);
    }
    if (input.errors.length > 0) {
        lines.push('');
        lines.push('## Error classes');
        const counts = new Map<string, number>();
        for (const observation of input.errors) {
            const key = observation.errorClass ?? 'unknown';
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [key, count] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
            lines.push(`- ${key} (${errorClassLabel(key)}): ${count}`);
        }
    }
    lines.push('');
    return lines.join('\n');
};

/** True when the observation is a clean "the effort was rejected" (not an error) */
export const isCleanRejection = (observation: ProbeObservation): boolean =>
    observation.errorClass !== null && isRejectionClass(observation.errorClass);

/** Re-exported for callers that only need the wire outcome */
export type { ProbeWireOutcome };
