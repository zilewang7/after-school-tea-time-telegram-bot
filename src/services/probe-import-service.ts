/**
 * `/probe import`: turn a thinking-effort probe result document into capability
 * proposals for the owner's approval (thinking-effort design 2026-1113-1742 §7).
 *
 * The document is the one `scripts/probe/thinking-effort.mts` writes:
 * `{ schema, probedAt, laneSignature, results: [{ model, acceptedEfforts,
 * defaultEffort, toggle, errorSummary, checkedOn }] }`. The importer is the only
 * consumer: it whitelists the known fields (unknown keys are ignored by design),
 * rejects the whole file on a bad shape or an unknown effort value, and never
 * writes the catalog itself. It maps each row to the reasoning block of that
 * model and asks the PR3 capability-proposal service to insert/refresh a pending
 * proposal — the owner's buttons decide what lands.
 *
 * Rules encoded here (design §2.1, §7):
 * - `manual` reasoning data is never proposed over (probe is below manual);
 * - a model the catalog does not know is skipped, never created;
 * - probe results only touch the reasoning subtree plus its provenance
 *   (`source='probe'`, `checkedOn`, `confidence='high'`): `enabled`, `label`,
 *   price, modalities, tools and the seed-only tool-mixing facts stay untouched;
 * - `defaultEffort` outside the accepted set becomes null, exactly like the
 *   catalog normalizer does (a relay that replaced the vendor default must not
 *   publish a default the menu cannot offer);
 * - re-importing the same file refreshes the same pending rows, and importing
 *   after the owner approved it changes nothing.
 */
import {
    MODEL_EFFORTS,
    type ModelCatalogCapabilities,
    type ModelCatalogReasoning,
    type ModelEffort,
} from '../config/model-capabilities.js';
import { capabilityFieldChangesOf, type CapabilityProposalInput } from './model-capability-service.js';

/** Design §7: the import rejects a document above 1 MB */
export const PROBE_IMPORT_MAX_BYTES = 1_048_576;

/** Design §7: the only document version this importer understands */
export const PROBE_IMPORT_SCHEMA = 1;

/** Safety cap on one file's rows; a probe run has at most a few dozen models */
export const PROBE_IMPORT_MAX_RESULTS = 200;

/** Direct measurement, above a catalog guess: probe proposals carry high confidence */
export const PROBE_IMPORT_CONFIDENCE = 'high' as const;

/** `application/json` is the only accepted document type (design §7) */
export const PROBE_IMPORT_MIME_TYPE = 'application/json';

export interface ProbeEffortResult {
    readonly model: string;
    readonly acceptedEfforts: readonly ModelEffort[];
    readonly defaultEffort: ModelEffort | null;
    readonly toggle: boolean;
    /** Evidence of the rejected effort values; not written into the catalog */
    readonly errorSummary: Readonly<Record<string, string>>;
    /** YYYY-MM-DD the probe ran for this model */
    readonly checkedOn: string;
}

export interface ProbeResultDocument {
    readonly schema: 1;
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly results: readonly ProbeEffortResult[];
}

export type ProbeImportParseResult =
    | { readonly ok: true; readonly document: ProbeResultDocument }
    | { readonly ok: false; readonly errors: readonly string[] };

/** One catalog row the importer may propose a change for */
export interface ProbeCatalogModel {
    readonly model: string;
    /** A disabled (retired) row leaves the menu; its probe data is not worth a proposal */
    readonly enabled: boolean;
    readonly capabilities: ModelCatalogCapabilities;
}

export interface ProbeImportDependencies {
    readonly listCatalogModels: () => Promise<readonly ProbeCatalogModel[]>;
    readonly upsertProposal: (input: CapabilityProposalInput) => Promise<number>;
}

export interface PlannedProbeProposal {
    readonly model: string;
    readonly payload: ModelCatalogCapabilities;
    readonly baseline: ModelCatalogCapabilities;
    readonly note: string;
    readonly checkedOn: string;
    /** Human-readable changed fields, for the command's summary */
    readonly changes: readonly string[];
}

export interface ProbeImportSkip {
    readonly model: string;
    readonly reason: string;
}

export interface ProbeImportPlan {
    readonly laneSignature: string;
    readonly proposals: readonly PlannedProbeProposal[];
    readonly skipped: readonly ProbeImportSkip[];
    /** Rows whose probe data equals what the catalog already says */
    readonly unchanged: readonly string[];
}

export type ProbeImportRunResult =
    | {
          readonly ok: true;
          readonly document: ProbeResultDocument;
          readonly plan: ProbeImportPlan;
          readonly proposalIds: readonly number[];
      }
    | { readonly ok: false; readonly errors: readonly string[] };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EFFORT_SET: ReadonlySet<string> = new Set(MODEL_EFFORTS);
const MAX_MODEL_ID_LENGTH = 128;
const MAX_LANE_SIGNATURE_LENGTH = 500;
const MAX_ERROR_SUMMARY_VALUE_LENGTH = 2_000;
const MAX_REPORTED_ERRORS = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isEffort = (value: unknown): value is ModelEffort => isString(value) && EFFORT_SET.has(value);

/** A real calendar day, not just a date-shaped string (Date.parse would roll 02-30 over) */
const isValidDate = (value: string): boolean => {
    if (!DATE_PATTERN.test(value)) return false;
    const parts = value.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Rank lookup for canonical (ascending) order of the effort words */
const effortRank = (effort: ModelEffort): number => MODEL_EFFORTS.findIndex((candidate) => candidate === effort);

const sortEfforts = (efforts: readonly ModelEffort[]): readonly ModelEffort[] =>
    [...efforts].sort((first, second) => effortRank(first) - effortRank(second));

/** A non-empty string with a byte cap; problem text is the field name */
const requiredStringOf = (
    value: unknown,
    label: string,
    maxLength: number,
    errors: string[]
): string | null => {
    if (!isString(value) || value.trim() === '') {
        errors.push(`${label} 必须是非空字符串`);
        return null;
    }
    if (value.length > maxLength) {
        errors.push(`${label} 超过 ${maxLength} 字符`);
        return null;
    }
    return value;
};

const acceptedEffortsOf = (value: unknown, label: string, errors: string[]): readonly ModelEffort[] | null => {
    if (!Array.isArray(value)) {
        errors.push(`${label} 必须是数组`);
        return null;
    }
    const efforts: ModelEffort[] = [];
    const seen = new Set<string>();
    value.forEach((item, index) => {
        if (!isEffort(item)) {
            errors.push(`${label}[${index}] 不是合法档位（允许 ${MODEL_EFFORTS.join('/')}）`);
            return;
        }
        if (seen.has(item)) {
            errors.push(`${label}[${index}] 重复（${item}）`);
            return;
        }
        seen.add(item);
        efforts.push(item);
    });
    return efforts;
};

const errorSummaryOf = (value: unknown, label: string, errors: string[]): Record<string, string> => {
    if (value === undefined) return {};
    if (!isRecord(value)) {
        errors.push(`${label} 必须是对象`);
        return {};
    }
    const summary: Record<string, string> = {};
    for (const [key, message] of Object.entries(value)) {
        if (!isString(message)) {
            errors.push(`${label}.${key} 必须是字符串`);
            continue;
        }
        if (message.length > MAX_ERROR_SUMMARY_VALUE_LENGTH) {
            errors.push(`${label}.${key} 超过 ${MAX_ERROR_SUMMARY_VALUE_LENGTH} 字符`);
            continue;
        }
        // Unknown keys are evidence labels (an effort value, baseline, …): kept as-is
        summary[key] = message;
    }
    return summary;
};

const resultOf = (value: unknown, index: number, errors: string[]): ProbeEffortResult | null => {
    if (!isRecord(value)) {
        errors.push(`results[${index}] 必须是对象`);
        return null;
    }
    const label = `results[${index}]`;
    const model = requiredStringOf(value.model, `${label}.model`, MAX_MODEL_ID_LENGTH, errors);
    const acceptedEfforts = acceptedEffortsOf(value.acceptedEfforts, `${label}.acceptedEfforts`, errors);
    const defaultEffort = value.defaultEffort;
    if (defaultEffort !== null && defaultEffort !== undefined && !isEffort(defaultEffort)) {
        errors.push(`${label}.defaultEffort 不是合法档位或 null`);
    }
    if (value.toggle === undefined || typeof value.toggle !== 'boolean') {
        errors.push(`${label}.toggle 必须是布尔值`);
    }
    const errorSummary = errorSummaryOf(value.errorSummary, `${label}.errorSummary`, errors);
    const checkedOnRaw = value.checkedOn;
    const checkedOn = isString(checkedOnRaw) && isValidDate(checkedOnRaw) ? checkedOnRaw : null;
    if (checkedOn === null) errors.push(`${label}.checkedOn 必须是 YYYY-MM-DD 日期`);
    if (model === null || acceptedEfforts === null || checkedOn === null) return null;
    return {
        model,
        acceptedEfforts: sortEfforts(acceptedEfforts),
        defaultEffort: isEffort(defaultEffort) ? defaultEffort : null,
        toggle: value.toggle === true,
        errorSummary,
        checkedOn,
    };
};

/**
 * Parse and whitelist one probe result document. Never throws: a malformed or
 * unsupported file yields all problems and no document, so the command can
 * explain every failure instead of a generic "格式错误".
 */
export const parseProbeImportDocument = (bytes: Uint8Array): ProbeImportParseResult => {
    if (bytes.byteLength === 0) return { ok: false, errors: ['文档为空'] };
    if (bytes.byteLength > PROBE_IMPORT_MAX_BYTES) {
        return { ok: false, errors: [`文档 ${bytes.byteLength} 字节，超过 1 MB 上限`] };
    }
    const text = Buffer.from(bytes).toString('utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, errors: [`不是合法 JSON：${detail}`] };
    }
    if (!isRecord(parsed)) return { ok: false, errors: ['顶层必须是 JSON 对象'] };
    const errors: string[] = [];
    if (parsed.schema !== PROBE_IMPORT_SCHEMA) {
        errors.push(`schema 必须是 ${PROBE_IMPORT_SCHEMA}`);
    }
    const probedAt = isString(parsed.probedAt) && !Number.isNaN(Date.parse(parsed.probedAt)) ? parsed.probedAt : null;
    if (probedAt === null) errors.push('probedAt 不是 ISO 时间');
    const laneSignature = requiredStringOf(parsed.laneSignature, 'laneSignature', MAX_LANE_SIGNATURE_LENGTH, errors);
    const resultsRaw = parsed.results;
    const results: ProbeEffortResult[] = [];
    if (!Array.isArray(resultsRaw)) {
        errors.push('results 必须是数组');
    } else if (resultsRaw.length > PROBE_IMPORT_MAX_RESULTS) {
        errors.push(`results 超过 ${PROBE_IMPORT_MAX_RESULTS} 条上限`);
    } else {
        resultsRaw.forEach((entry, index) => {
            const result = resultOf(entry, index, errors);
            if (result !== null) results.push(result);
        });
        const seen = new Set<string>();
        for (const result of results) {
            if (seen.has(result.model)) errors.push(`results 中 model 重复：${result.model}`);
            seen.add(result.model);
        }
    }
    if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS) };
    if (probedAt === null || laneSignature === null) {
        // Guarded above; kept so the type narrows without a cast
        return { ok: false, errors: ['文档头缺少 probedAt/laneSignature'] };
    }
    return {
        ok: true,
        document: { schema: PROBE_IMPORT_SCHEMA, probedAt, laneSignature, results },
    };
};

/**
 * The reasoning section an import builds: values from the probe document,
 * provenance from the import. The vendor default is only kept when the probe's
 * accepted set contains it (a relay that replaced the default must not publish
 * a default the menu cannot offer). `defaultEnabled` is not something a W1/W2
 * probe infers, so the catalog's existing value is preserved for toggle models.
 *
 * A measurement that found efforts (or a toggle) wins over a catalog row that
 * says "no reasoning": the old `current.supported ?? …` kept a seeded
 * `supported:false` and produced a `supported:false` + non-empty efforts
 * payload, which the normalizer clears — the approval message showed a change
 * that could never land. The reverse (probe found nothing, catalog says
 * supported) keeps the catalog value.
 */
const reasoningOf = (
    current: ModelCatalogReasoning | undefined,
    result: ProbeEffortResult,
    efforts: readonly ModelEffort[]
): ModelCatalogReasoning => {
    const defaultEffort =
        result.defaultEffort !== null && efforts.some((effort) => effort === result.defaultEffort)
            ? result.defaultEffort
            : null;
    const supported = efforts.length > 0 || result.toggle || current?.supported === true;
    const defaultEnabled = result.toggle ? (current?.defaultEnabled ?? null) : null;
    return {
        supported,
        toggle: result.toggle,
        efforts,
        defaultEffort,
        defaultEnabled,
        source: 'probe',
        checkedOn: result.checkedOn,
        confidence: PROBE_IMPORT_CONFIDENCE,
    };
};

/** Fields whose provenance alone may still be worth a proposal (a re-check) */
const provenanceChanged = (
    current: ModelCatalogReasoning | undefined,
    payload: ModelCatalogReasoning
): boolean =>
    current?.source !== payload.source ||
    current?.checkedOn !== payload.checkedOn ||
    current?.confidence !== payload.confidence;

/**
 * The note one proposal carries: the changed fields the approval message shows,
 * or "data synced" when only the provenance moved (a probe re-check that found
 * the same values). The lane signature is kept so the owner can tell which
 * traffic path the measurement came from.
 */
const noteOf = (changes: readonly string[], laneSignature: string, checkedOn: string): string => {
    if (changes.length === 0) {
        return `probe 导入：能力数据同步（lane ${laneSignature}，${checkedOn}，置信 high）`;
    }
    const shown = changes.slice(0, 4).join('、');
    const more = changes.length > 4 ? ` 等 ${changes.length} 项` : '';
    return `probe 导入：${shown}${more}（lane ${laneSignature}，${checkedOn}，置信 high）`;
};

/**
 * Map a parsed document onto the current catalog and build the proposals. Pure
 * (the catalog comes in as data), so the mapping rules are testable without a DB.
 */
export const planProbeImport = (
    document: ProbeResultDocument,
    catalog: readonly ProbeCatalogModel[]
): ProbeImportPlan => {
    const currentByModel = new Map(catalog.map((entry) => [entry.model, entry]));
    const proposals: PlannedProbeProposal[] = [];
    const skipped: ProbeImportSkip[] = [];
    const unchanged: string[] = [];
    for (const result of document.results) {
        const entry = currentByModel.get(result.model);
        if (entry === undefined) {
            skipped.push({ model: result.model, reason: 'catalog 中没有该模型，无法生成能力提案' });
            continue;
        }
        if (!entry.enabled) {
            skipped.push({ model: result.model, reason: '模型未启用（enabled=0），跳过' });
            continue;
        }
        const current = entry.capabilities;
        // Local knowledge outranks a measurement (design §2.1): the owner's own
        // edits and the official-doc facts the seed stores are never proposed over.
        if (current.reasoning?.source === 'manual') {
            skipped.push({ model: result.model, reason: '思考档位由机主手改维护（manual 优先于 probe）' });
            continue;
        }
        if (current.reasoning?.source === 'official') {
            skipped.push({ model: result.model, reason: '思考档位由官方文档维护（official 优先于 probe）' });
            continue;
        }
        const efforts = sortEfforts(result.acceptedEfforts);
        const reasoning = reasoningOf(current.reasoning, result, efforts);
        const payload: ModelCatalogCapabilities = {
            ...current,
            schema: 1,
            // Legacy mirror stays in sync for old readers
            reasoningEffort: efforts,
            reasoning,
        };
        const fieldChanges = capabilityFieldChangesOf(payload, current);
        const synced = fieldChanges.length === 0 && !provenanceChanged(current.reasoning, reasoning);
        if (synced) {
            unchanged.push(result.model);
            continue;
        }
        const changes = fieldChanges.map((change) => change.label);
        proposals.push({
            model: result.model,
            payload,
            baseline: current,
            note: noteOf(changes, document.laneSignature, result.checkedOn),
            checkedOn: result.checkedOn,
            changes,
        });
    }
    return { laneSignature: document.laneSignature, proposals, skipped, unchanged };
};

/**
 * Parse, plan and hand every change to the PR3 proposal service. Nothing is
 * written to `model_catalog` here; the owner's approval does that.
 */
export const importProbeResultDocument = async (
    bytes: Uint8Array,
    dependencies: ProbeImportDependencies
): Promise<ProbeImportRunResult> => {
    const parsed = parseProbeImportDocument(bytes);
    if (!parsed.ok) return parsed;
    const catalog = await dependencies.listCatalogModels();
    const plan = planProbeImport(parsed.document, catalog);
    const proposalIds: number[] = [];
    for (const proposal of plan.proposals) {
        const id = await dependencies.upsertProposal({
            model: proposal.model,
            payload: proposal.payload,
            baseline: proposal.baseline,
            note: proposal.note,
            checkedOn: proposal.checkedOn,
        });
        proposalIds.push(id);
    }
    return { ok: true, document: parsed.document, plan, proposalIds };
};
