/**
 * From raw observations to the v2 artifact the owner imports (§3.6).
 *
 * `results.json` (schema 2) records only measured facts: accepted efforts,
 * mapped efforts (accepted outside the vendor list), measured toggle support
 * (only when toggle candidates actually ran), client-tool fidelity checks,
 * per-platform lane fingerprints, and error summaries. It never copies
 * `vendorDefaultEffort` into `results.json`.
 *
 * An incomplete model row is left out on purpose: a model that only answered
 * half its candidates would otherwise publish a truncated `acceptedEfforts`
 * list, and the import would shrink the product's menu.
 */
import {
    EFFORT_LABELS,
    ERROR_SUMMARY_LIMIT,
    PLATFORM_ORDER_LIST,
    isEffortValue,
    isProbePlatform,
    sortEfforts,
    type EffortValue,
    type ProbeCandidate,
    type ProbeLaneFingerprints,
    type ProbeModelSpec,
    type ProbeObservation,
    type ProbePlatform,
    type ProbeResultDocument,
    type ProbeResultDocumentV1,
    type ProbeResultDocumentV2,
    type ProbeResultEntryV1,
    type ProbeResultEntryV2,
    type ProbeToolsCheck,
    type ProbeVariant,
    type ProbeWireOutcome,
    type ValidationResult,
} from './effort-types.mts';
import { errorClassLabel, isRejectionClass } from './effort-errors.mts';
import { PROBE_VARIANTS } from './effort-types.mts';

/** Worst case the runner reserves before a request; actual usage replaces it */
export const billedCostUsd = (spec: ProbeModelSpec, observation: ProbeObservation): number => {
    const output = observation.outputTokens ?? observation.reasoningTokens;
    if (observation.inputTokens === null && output === null) return observation.estimatedCostUsd;
    const input = observation.inputTokens ?? 0;
    const usd =
        (input * spec.price.inputPerMillionUsd + (output ?? 0) * spec.price.outputPerMillionUsd) / 1_000_000;
    return Math.round(usd * 1_000_000) / 1_000_000;
};

/** The label of one candidate in the error summary */
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

/** Candidates whose final attempt proves the model matrix is not trustworthy */
const UNRELIABLE_CLASSES: ReadonlySet<string> = new Set([
    'auth_error',
    'model_missing',
    'lane_error',
    'rate_limited',
    'upstream_error',
    'network_error',
]);

export interface ModelInference {
    readonly spec: ProbeModelSpec;
    readonly lane: string;
    readonly w1Observations: readonly ProbeObservation[];
    readonly acceptedEfforts: readonly EffortValue[];
    /** Accepted values outside the vendor list: the lane maps them to another level */
    readonly mappedEfforts: readonly EffortValue[];
    /** Measured toggle capability; null when no toggle candidate ran */
    readonly toggle: boolean | null;
    /** Client-tool fidelity variant result; null when none ran or unreliable */
    readonly tools: ProbeToolsCheck | null;
    readonly errorSummary: Readonly<Record<string, string>>;
    readonly incomplete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly rejected: readonly ProbeObservation[];
}

const summarizeToolsObservations = (observations: readonly ProbeObservation[]): ProbeToolsCheck | null => {
    if (observations.length === 0) return null;
    for (const observation of observations) {
        if (observation.outcome === 'rejected' || (observation.errorClass !== null && isRejectionClass(observation.errorClass))) {
            return {
                supported: false,
                variant: observation.variant,
                effort: observation.effort,
                ...(observation.errorSummary === null ? {} : { error: observation.errorSummary }),
            };
        }
    }
    const accepted = observations.find((observation) => observation.outcome === 'accepted');
    if (accepted === undefined) return null;
    return {
        supported: true,
        variant: accepted.variant,
        effort: accepted.effort,
    };
};

const summarizeModelInner = (
    spec: ProbeModelSpec,
    observations: readonly ProbeObservation[],
    fallbackLane: string
): ModelInference => {
    const w1 = observations.filter((observation) => observation.wave === 'w1' && observation.model === spec.model);
    const finalW1 = new Map<string, ProbeObservation>();
    for (const observation of w1) {
        const previous = finalW1.get(observation.candidateId);
        if (previous === undefined || observation.attempt >= previous.attempt) finalW1.set(observation.candidateId, observation);
    }

    const incompleteReasons: string[] = [];
    const rejected: ProbeObservation[] = [];
    const acceptedLevels: EffortValue[] = [];
    const toolsObservations: ProbeObservation[] = [];
    const vendorSet = new Set(spec.vendorEfforts);
    let baselineAccepted = false;
    let toggleMeasured: boolean | null = null;

    for (const observation of finalW1.values()) {
        const candidate = candidateOfObservation(observation);
        const label = candidateLabelOf(candidate);
        if (candidate.withClientTools) {
            toolsObservations.push(observation);
            continue;
        }
        if (observation.outcome === 'accepted') {
            if (observation.variant === 'baseline') baselineAccepted = true;
            else if (observation.variant === 'level' && observation.effort !== null) acceptedLevels.push(observation.effort);
            else if (observation.variant === 'toggle-off') toggleMeasured = true;
            continue;
        }
        const errorClass = observation.errorClass ?? 'unclassified';
        if (UNRELIABLE_CLASSES.has(errorClass)) {
            incompleteReasons.push(`${label}: ${errorClass}`);
            continue;
        }
        rejected.push(observation);
        if (observation.variant === 'toggle-off' && isRejectionClass(errorClass) && toggleMeasured === null) {
            toggleMeasured = false;
        }
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
    const tools = summarizeToolsObservations(toolsObservations);
    const lane = w1[w1.length - 1]?.laneId ?? fallbackLane;

    const errorSummary: Record<string, string> = {};
    for (const observation of rejected) {
        if (observation.errorSummary === null) continue;
        const label = candidateLabelOf(candidateOfObservation(observation));
        if (errorSummary[label] === undefined) errorSummary[label] = observation.errorSummary;
    }

    return {
        spec,
        lane,
        w1Observations: w1,
        acceptedEfforts,
        mappedEfforts,
        toggle: toggleMeasured,
        tools,
        errorSummary,
        incomplete: incompleteReasons.length > 0,
        incompleteReasons,
        rejected,
    };
};

/** One model's row plus the reasoning behind it */
export const summarizeModel = (
    spec: ProbeModelSpec,
    observations: readonly ProbeObservation[],
    fallbackLane = 'unknown'
): ModelInference => summarizeModelInner(spec, observations, fallbackLane);

export interface ProbeRunSummary {
    readonly probedAt: string;
    readonly lanes: ProbeLaneFingerprints;
    readonly checkedOn: string;
    readonly document: ProbeResultDocumentV2;
    readonly inferences: readonly ModelInference[];
    /** Models left out of the document and why */
    readonly incomplete: readonly ModelInference[];
}

export const checkedOnOf = (probedAt: string): string => probedAt.slice(0, 10);

/**
 * Build the v2 result document (§3.6). Only complete W1 matrices enter it;
 * only measured facts are written (no `vendorDefaultEffort` fallback).
 */
export const buildRunSummary = (input: {
    readonly probedAt: string;
    readonly lanes: ProbeLaneFingerprints;
    readonly specs: readonly ProbeModelSpec[];
    readonly observations: readonly ProbeObservation[];
}): ProbeRunSummary => {
    const inferences: ModelInference[] = [];
    for (const spec of input.specs) {
        if (!input.observations.some((observation) => observation.model === spec.model)) continue;
        const fallbackLane = input.lanes[spec.platform] ?? 'unknown';
        inferences.push(summarizeModel(spec, input.observations, fallbackLane));
    }
    const complete = inferences.filter((inference) => !inference.incomplete);
    const checkedOn = checkedOnOf(input.probedAt);
    const results: ProbeResultEntryV2[] = complete.map((inference) => ({
        model: inference.spec.model,
        platform: inference.spec.platform,
        lane: inference.lane,
        acceptedEfforts: inference.acceptedEfforts,
        mappedEfforts: inference.mappedEfforts,
        toggle: inference.toggle,
        tools: inference.tools,
        errorSummary: inference.errorSummary,
        checkedOn,
    }));
    const usedLanes: Partial<Record<ProbePlatform, string>> = {};
    for (const entry of results) {
        usedLanes[entry.platform] = entry.lane;
    }
    if (results.length === 0) {
        for (const inference of inferences) {
            usedLanes[inference.spec.platform] = inference.lane;
        }
    }
    return {
        probedAt: input.probedAt,
        lanes: usedLanes,
        checkedOn,
        document: { schema: 2, probedAt: input.probedAt, lanes: usedLanes, results },
        inferences,
        incomplete: inferences.filter((inference) => inference.incomplete),
    };
};

// ---------------------------------------------------------------------------
// Schema validation (v2 + legacy v1 compatibility)
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isProbeVariant = (value: unknown): value is ProbeVariant =>
    typeof value === 'string' && PROBE_VARIANTS.some((variant) => variant === value);

const pushProblem = (problems: string[], message: string): void => {
    problems.push(message);
};

const validateEffortsArray = (value: unknown, fieldPath: string, problems: string[]): EffortValue[] => {
    if (!Array.isArray(value)) {
        pushProblem(problems, `${fieldPath} is not an array`);
        return [];
    }
    const efforts: EffortValue[] = [];
    const seen = new Set<string>();
    value.forEach((effort, position) => {
        if (typeof effort !== 'string' || !isEffortValue(effort)) {
            pushProblem(problems, `${fieldPath}[${position}] is not a closed-set effort`);
            return;
        }
        if (seen.has(effort)) pushProblem(problems, `${fieldPath}[${position}] is duplicated`);
        seen.add(effort);
        efforts.push(effort);
    });
    return sortEfforts(efforts);
};

const validateErrorSummary = (value: unknown, fieldPath: string, problems: string[]): Record<string, string> => {
    if (!isRecord(value)) {
        pushProblem(problems, `${fieldPath} is not an object`);
        return {};
    }
    const result: Record<string, string> = {};
    for (const [label, message] of Object.entries(value)) {
        if (typeof message !== 'string') pushProblem(problems, `${fieldPath}.${label} is not a string`);
        else if (message.length > ERROR_SUMMARY_LIMIT) {
            pushProblem(problems, `${fieldPath}.${label} is longer than ${ERROR_SUMMARY_LIMIT} characters`);
        } else {
            result[label] = message;
        }
    }
    return result;
};

const validateCheckedOn = (value: unknown, fieldPath: string, problems: string[]): string => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        pushProblem(problems, `${fieldPath} is not a YYYY-MM-DD date`);
        return '';
    }
    return value;
};

const validateToolsCheck = (value: unknown, fieldPath: string, problems: string[]): ProbeToolsCheck | null => {
    if (value === null) return null;
    if (!isRecord(value)) {
        pushProblem(problems, `${fieldPath} must be an object or null`);
        return null;
    }
    if (typeof value['supported'] !== 'boolean') {
        pushProblem(problems, `${fieldPath}.supported must be a boolean`);
    }
    const variant = value['variant'];
    if (!isProbeVariant(variant)) {
        pushProblem(problems, `${fieldPath}.variant is not a valid probe variant`);
    }
    const effort = value['effort'];
    if (effort !== null && (typeof effort !== 'string' || !isEffortValue(effort))) {
        pushProblem(problems, `${fieldPath}.effort is neither null nor a closed-set effort`);
    }
    const error = value['error'];
    if (error !== undefined && typeof error !== 'string') {
        pushProblem(problems, `${fieldPath}.error must be a string`);
    }
    if (typeof value['supported'] !== 'boolean' || !isProbeVariant(variant)) return null;
    return {
        supported: value['supported'],
        variant,
        effort: typeof effort === 'string' && isEffortValue(effort) ? effort : null,
        ...(typeof error === 'string' ? { error } : {}),
    };
};

const validateEntryV1 = (value: unknown, index: number, problems: string[]): ProbeResultEntryV1 | null => {
    if (!isRecord(value)) {
        pushProblem(problems, `results[${index}] is not an object`);
        return null;
    }
    if (typeof value['model'] !== 'string' || value['model'] === '') {
        pushProblem(problems, `results[${index}].model is not a non-empty string`);
    }
    const acceptedEfforts = validateEffortsArray(value['acceptedEfforts'], `results[${index}].acceptedEfforts`, problems);
    const defaultEffort = value['defaultEffort'];
    if (defaultEffort !== null && (typeof defaultEffort !== 'string' || !isEffortValue(defaultEffort))) {
        pushProblem(problems, `results[${index}].defaultEffort is neither null nor a closed-set effort`);
    }
    if (typeof value['toggle'] !== 'boolean') pushProblem(problems, `results[${index}].toggle is not a boolean`);
    const errorSummary = validateErrorSummary(value['errorSummary'], `results[${index}].errorSummary`, problems);
    const checkedOn = validateCheckedOn(value['checkedOn'], `results[${index}].checkedOn`, problems);
    if (typeof value['model'] !== 'string' || value['model'] === '') return null;
    return {
        model: value['model'],
        acceptedEfforts,
        defaultEffort: typeof defaultEffort === 'string' && isEffortValue(defaultEffort) ? defaultEffort : null,
        toggle: value['toggle'] === true,
        errorSummary,
        checkedOn,
    };
};

const validateEntryV2 = (value: unknown, index: number, problems: string[]): ProbeResultEntryV2 | null => {
    if (!isRecord(value)) {
        pushProblem(problems, `results[${index}] is not an object`);
        return null;
    }
    const model = value['model'];
    if (typeof model !== 'string' || model === '') {
        pushProblem(problems, `results[${index}].model is not a non-empty string`);
    }
    const platform = value['platform'];
    if (typeof platform !== 'string' || !isProbePlatform(platform)) {
        pushProblem(problems, `results[${index}].platform is not a known probe platform`);
    }
    const lane = value['lane'];
    if (typeof lane !== 'string' || lane === '') {
        pushProblem(problems, `results[${index}].lane is not a non-empty string`);
    }
    const acceptedEfforts = validateEffortsArray(value['acceptedEfforts'], `results[${index}].acceptedEfforts`, problems);
    const mappedEfforts =
        value['mappedEfforts'] === undefined
            ? []
            : validateEffortsArray(value['mappedEfforts'], `results[${index}].mappedEfforts`, problems);
    const toggle = value['toggle'];
    if (toggle !== null && typeof toggle !== 'boolean') {
        pushProblem(problems, `results[${index}].toggle must be a boolean or null`);
    }
    const tools = value['tools'] === undefined ? null : validateToolsCheck(value['tools'], `results[${index}].tools`, problems);
    const errorSummary = validateErrorSummary(value['errorSummary'], `results[${index}].errorSummary`, problems);
    const checkedOn = validateCheckedOn(value['checkedOn'], `results[${index}].checkedOn`, problems);
    if (typeof model !== 'string' || model === '' || typeof platform !== 'string' || !isProbePlatform(platform) || typeof lane !== 'string' || lane === '') {
        return null;
    }
    return {
        model,
        platform,
        lane,
        acceptedEfforts,
        mappedEfforts,
        toggle: typeof toggle === 'boolean' ? toggle : null,
        tools,
        errorSummary,
        checkedOn,
    };
};

const validateLanesMap = (value: unknown, problems: string[]): ProbeLaneFingerprints => {
    if (!isRecord(value)) {
        pushProblem(problems, 'lanes is not an object');
        return {};
    }
    const lanes: Partial<Record<ProbePlatform, string>> = {};
    for (const [platform, fingerprint] of Object.entries(value)) {
        if (!isProbePlatform(platform)) {
            pushProblem(problems, `lanes.${platform} is not a known probe platform`);
            continue;
        }
        if (typeof fingerprint !== 'string' || fingerprint === '') {
            pushProblem(problems, `lanes.${platform} is not a non-empty string`);
            continue;
        }
        lanes[platform] = fingerprint;
    }
    return lanes;
};

/**
 * Validate a v2 (or legacy v1) import document. Unknown keys are ignored;
 * known keys are checked strictly. Never throws.
 */
export const validateProbeDocument = (value: unknown): ValidationResult => {
    const problems: string[] = [];
    if (!isRecord(value)) {
        return { valid: false, errors: ['the document is not a JSON object'], document: null };
    }
    const schema = value['schema'];
    if (schema !== 1 && schema !== 2) {
        pushProblem(problems, 'schema must be 1 or 2');
        return { valid: false, errors: problems, document: null };
    }
    const probedAt = value['probedAt'];
    if (typeof probedAt !== 'string' || probedAt === '' || Number.isNaN(Date.parse(probedAt))) {
        pushProblem(problems, 'probedAt is not an ISO timestamp');
    }
    const resultsRaw = value['results'];
    if (!Array.isArray(resultsRaw)) {
        pushProblem(problems, 'results is not an array');
    }

    if (schema === 1) {
        const laneSignature = value['laneSignature'];
        if (typeof laneSignature !== 'string' || laneSignature === '') {
            pushProblem(problems, 'laneSignature is not a non-empty string');
        }
        const parsedEntries: ProbeResultEntryV1[] = [];
        if (Array.isArray(resultsRaw)) {
            resultsRaw.forEach((entry, index) => {
                const parsed = validateEntryV1(entry, index, problems);
                if (parsed !== null) parsedEntries.push(parsed);
            });
        }
        if (problems.length > 0) return { valid: false, errors: problems, document: null };
        const document: ProbeResultDocumentV1 = {
            schema: 1,
            probedAt: String(probedAt),
            laneSignature: String(laneSignature),
            results: parsedEntries,
        };
        return { valid: true, errors: [], document };
    }

    const lanes = validateLanesMap(value['lanes'], problems);
    const parsedEntries: ProbeResultEntryV2[] = [];
    if (Array.isArray(resultsRaw)) {
        resultsRaw.forEach((entry, index) => {
            const parsed = validateEntryV2(entry, index, problems);
            if (parsed !== null) parsedEntries.push(parsed);
        });
    }
    if (problems.length > 0) return { valid: false, errors: problems, document: null };
    const document: ProbeResultDocumentV2 = {
        schema: 2,
        probedAt: String(probedAt),
        lanes,
        results: parsedEntries,
    };
    return { valid: true, errors: [], document };
};

// ---------------------------------------------------------------------------
// Merging multiple runs into one v2 document (§3.6)
// ---------------------------------------------------------------------------

/** Prefix routing mirror of `src/config/platform-routing.ts` (never imports src/) */
const platformOfLegacyModel = (model: string): ProbePlatform => {
    const id = model.toLowerCase();
    if (id.startsWith('gemini')) return 'gemini';
    if (id.startsWith('deepseek')) return 'deepseek';
    if (id.startsWith('grok-')) return 'grok';
    if (id.startsWith('mimo')) return 'mimo';
    if (id.startsWith('claude')) return 'anthropic';
    return 'openai';
};

const legacyLanesFromSignature = (laneSignature: string): ProbeLaneFingerprints => {
    const parts = laneSignature.split('|');
    if (parts.length !== PLATFORM_ORDER_LIST.length) return {};
    const lanes: Partial<Record<ProbePlatform, string>> = {};
    PLATFORM_ORDER_LIST.forEach((platform, index) => {
        const part = parts[index];
        if (part !== undefined && part !== '') lanes[platform] = part;
    });
    return lanes;
};

const toV2Entries = (document: ProbeResultDocument): readonly ProbeResultEntryV2[] => {
    if (document.schema === 2) return document.results;
    const legacyLanes = legacyLanesFromSignature(document.laneSignature);
    return document.results.map((entry): ProbeResultEntryV2 => {
        const platform = platformOfLegacyModel(entry.model);
        return {
            model: entry.model,
            platform,
            lane: legacyLanes[platform] ?? document.laneSignature,
            acceptedEfforts: entry.acceptedEfforts,
            mappedEfforts: [],
            toggle: entry.toggle,
            tools: null,
            errorSummary: entry.errorSummary,
            checkedOn: entry.checkedOn,
        };
    });
};

const lanesOfDocument = (document: ProbeResultDocument): ProbeLaneFingerprints =>
    document.schema === 2 ? document.lanes : legacyLanesFromSignature(document.laneSignature);

export interface ProbeMergeResult {
    readonly document: ProbeResultDocumentV2;
    readonly sourceCount: number;
    readonly replacedModels: readonly string[];
}

/**
 * Merge multiple v1/v2 `results.json` documents into one v2 document (§3.6).
 * When the same model appears in multiple documents, the newer `probedAt`
 * wins (ties break in favor of the later document in `documents`).
 */
export const mergeProbeDocuments = (documents: readonly ProbeResultDocument[]): ProbeMergeResult => {
    if (documents.length === 0) {
        throw new Error('at least one probe result document is required to merge');
    }
    const ordered = documents
        .map((document, index) => ({ document, index, timestamp: Date.parse(document.probedAt) }))
        .sort((left, right) => {
            if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
            return left.index - right.index;
        });

    const entriesByModel = new Map<string, ProbeResultEntryV2>();
    const replacedSet = new Set<string>();
    const mergedLanes: Partial<Record<ProbePlatform, string>> = {};

    for (const { document } of ordered) {
        for (const [platform, lane] of Object.entries(lanesOfDocument(document))) {
            if (isProbePlatform(platform) && typeof lane === 'string' && lane !== '') {
                mergedLanes[platform] = lane;
            }
        }
        for (const entry of toV2Entries(document)) {
            if (entriesByModel.has(entry.model)) replacedSet.add(entry.model);
            entriesByModel.set(entry.model, entry);
            mergedLanes[entry.platform] = entry.lane;
        }
    }

    const latestProbedAt = ordered[ordered.length - 1]!.document.probedAt;
    return {
        document: {
            schema: 2,
            probedAt: latestProbedAt,
            lanes: mergedLanes,
            results: [...entriesByModel.values()],
        },
        sourceCount: documents.length,
        replacedModels: [...replacedSet],
    };
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
    const byPlatform = new Map<string, { requests: number; usd: number }>();
    for (const candidate of input.candidates) {
        const entry = byPlatform.get(candidate.platform) ?? { requests: 0, usd: 0 };
        entry.requests += 1;
        entry.usd += candidate.estimatedCostUsd;
        byPlatform.set(candidate.platform, entry);
    }
    lines.push('platform   records  worst-case USD');
    for (const [platform, entry] of [...byPlatform.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        lines.push(
            `${platform.padEnd(10)} ${String(entry.requests).padStart(7)}  $${entry.usd.toFixed(4)}`
        );
    }
    lines.push(`total      ${String(input.candidates.length).padStart(7)}  worst-case $${input.estimatedUsd.toFixed(4)}`);
    return lines.join('\n');
};

const formatToolsColumn = (tools: ProbeToolsCheck | null): string => {
    if (tools === null) return '—';
    return tools.supported ? 'ok' : 'FAIL';
};

/** summary.md: the owner reads this before importing */
export const formatSummaryMarkdown = (input: {
    readonly probedAt: string;
    readonly lanes: ProbeLaneFingerprints;
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
    lines.push('# Thinking-effort probe (v2)');
    lines.push('');
    lines.push(`- started: ${input.startedAt}`);
    lines.push(`- finished: ${input.finishedAt}`);
    lines.push(`- lanes: ${Object.entries(input.lanes).map(([platform, lane]) => `${platform}=\`${lane}\``).join(', ') || '—'}`);
    lines.push(`- cost: $${input.spentUsd.toFixed(4)} of $${input.budgetUsd.toFixed(2)} budget`);
    lines.push(`- importable models: ${input.summary.document.results.length}`);
    lines.push('');
    lines.push('## Models');
    lines.push('');
    lines.push('| model | accepted (probe) | vendor efforts | toggle | mapped | tools | notes |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const inference of input.summary.inferences) {
        const notes: string[] = [];
        if (inference.incomplete) notes.push(`INCOMPLETE: ${inference.incompleteReasons.join('; ')}`);
        if (inference.tools !== null && !inference.tools.supported && inference.tools.error !== undefined) {
            notes.push(`tools rejected: ${inference.tools.error}`);
        }
        const toggleText = inference.toggle === null ? '—' : inference.toggle ? 'yes' : 'no';
        lines.push(
            `| ${inference.spec.model} | ${sortedEffortsText(inference.acceptedEfforts) || '—'} | ${sortedEffortsText(inference.spec.vendorEfforts) || '—'} | ${toggleText} | ${sortedEffortsText(inference.mappedEfforts) || '—'} | ${formatToolsColumn(inference.tools)} | ${notes.join(' / ') || ''} |`
        );
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
