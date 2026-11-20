/**
 * `/probe import` & `/probe export`: bridge between `scripts/probe/` and the
 * `model_catalog` proposal flow (thinking-effort design 2026-1113-1742 §7,
 * updated for v2 / field-level provenance in 2026-1114-0510 §3.2 & §3.6).
 *
 * `parseProbeImportDocument` accepts both v2 (`schema: 2`, per-platform lane
 * fingerprints, measured facts only, `mappedEfforts`, `tools`) and legacy v1
 * (`schema: 1`) result documents. It whitelists known fields, rejects the whole
 * file on invalid shape or unknown effort words, and never writes `model_catalog`
 * directly — every change goes through `model-capability-service` proposals.
 *
 * Provenance rules (§3.2 / §3.6):
 * - `manual` and `official` assertions on `reasoning.efforts` are never
 *   proposed over;
 * - a disabled (`enabled=0`) or missing catalog model is skipped;
 * - v2 probe imports only write provenance for what they actually measured:
 *   `reasoning.supported`, `reasoning.efforts`, and (when `toggle !== null`)
 *   `reasoning.toggle`, plus `laneFingerprints[platform]`. `defaultEffort` is
 *   never overwritten by probe v2 (preserved from catalog, or cleared to null
 *   if no longer inside `acceptedEfforts`).
 */
import {
    deriveFieldProvenance,
    fieldProvenanceOf,
    MODEL_EFFORTS,
    type CapabilityFieldProvenance,
    type CapabilityProvenanceMap,
    type ModelCatalogCapabilities,
    type ModelCatalogReasoning,
    type ModelEffort,
    type PlatformLaneFingerprints,
} from '../config/model-capabilities.js';
import { platformTypeOf, type PlatformType } from '../config/platform-routing.js';
import { capabilityFieldChangesOf, type CapabilityProposalInput } from './model-capability-service.js';

/** Design §7: the import rejects a document above 1 MB */
export const PROBE_IMPORT_MAX_BYTES = 1_048_576;

/** Current probe result schema version (§3.6) */
export const PROBE_IMPORT_SCHEMA = 2;

/** Legacy probe result schema version still accepted for backwards compatibility */
export const PROBE_IMPORT_LEGACY_SCHEMA = 1;

/** Safety cap on one file's rows; a probe run has at most a few dozen models */
export const PROBE_IMPORT_MAX_RESULTS = 200;

/** Direct measurement, above a catalog guess: probe proposals carry high confidence */
export const PROBE_IMPORT_CONFIDENCE = 'high' as const;

/** `application/json` is the only accepted document type (design §7) */
export const PROBE_IMPORT_MIME_TYPE = 'application/json';

export interface ProbeToolsResult {
    readonly supported: boolean;
    readonly variant: string;
    readonly effort: ModelEffort | null;
    readonly error?: string;
}

export interface ProbeEffortResultV2 {
    readonly model: string;
    readonly platform: PlatformType;
    readonly lane: string;
    readonly acceptedEfforts: readonly ModelEffort[];
    readonly mappedEfforts: readonly ModelEffort[];
    readonly toggle: boolean | null;
    readonly tools: ProbeToolsResult | null;
    /** Evidence of the rejected effort values; not written into the catalog */
    readonly errorSummary: Readonly<Record<string, string>>;
    /** YYYY-MM-DD the probe ran for this model */
    readonly checkedOn: string;
}

export interface ProbeEffortResultV1 {
    readonly model: string;
    readonly acceptedEfforts: readonly ModelEffort[];
    readonly defaultEffort: ModelEffort | null;
    readonly toggle: boolean;
    /** Evidence of the rejected effort values; not written into the catalog */
    readonly errorSummary: Readonly<Record<string, string>>;
    /** YYYY-MM-DD the probe ran for this model */
    readonly checkedOn: string;
}

export interface ProbeResultDocumentV2 {
    readonly schema: 2;
    readonly probedAt: string;
    readonly lanes: PlatformLaneFingerprints;
    readonly results: readonly ProbeEffortResultV2[];
}

export interface ProbeResultDocumentV1 {
    readonly schema: 1;
    readonly probedAt: string;
    readonly laneSignature: string;
    readonly results: readonly ProbeEffortResultV1[];
}

export type ProbeResultDocument = ProbeResultDocumentV2 | ProbeResultDocumentV1;

export type ProbeImportParseResult =
    | { readonly ok: true; readonly document: ProbeResultDocument }
    | { readonly ok: false; readonly errors: readonly string[] };

/** One catalog row the importer/exporter works with */
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
    readonly lanes: PlatformLaneFingerprints;
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

export interface ProbeExportPrice {
    readonly inputPerMillionUsd: number;
    readonly outputPerMillionUsd: number;
}

export interface ProbeExportedModelEntry {
    readonly model: string;
    readonly platform: PlatformType;
    readonly enabled: boolean;
    readonly vendorEfforts: readonly ModelEffort[];
    readonly vendorDefaultEffort: ModelEffort | null;
    readonly vendorToggle: boolean;
    readonly vendorDefaultEnabled: boolean | null;
    readonly price?: ProbeExportPrice;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EFFORT_SET: ReadonlySet<string> = new Set(MODEL_EFFORTS);
const PLATFORM_ORDER: readonly PlatformType[] = ['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'mimo'];
const PLATFORM_SET: ReadonlySet<string> = new Set<PlatformType>(PLATFORM_ORDER);
const PROBE_VARIANTS: ReadonlySet<string> = new Set([
    'baseline',
    'level',
    'budget',
    'toggle-on',
    'toggle-off',
    'invalid-shape',
]);
const MAX_MODEL_ID_LENGTH = 128;
const MAX_LANE_SIGNATURE_LENGTH = 500;
const MAX_ERROR_SUMMARY_VALUE_LENGTH = 2_000;
const MAX_REPORTED_ERRORS = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isEffort = (value: unknown): value is ModelEffort => isString(value) && EFFORT_SET.has(value);

const isPlatform = (value: unknown): value is PlatformType => isString(value) && PLATFORM_SET.has(value);

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
        summary[key] = message;
    }
    return summary;
};

const toolsResultOf = (value: unknown, label: string, errors: string[]): ProbeToolsResult | null => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) {
        errors.push(`${label} 必须是对象或 null`);
        return null;
    }
    if (typeof value.supported !== 'boolean') {
        errors.push(`${label}.supported 必须是布尔值`);
    }
    const variant = value.variant;
    if (!isString(variant) || !PROBE_VARIANTS.has(variant)) {
        errors.push(`${label}.variant 不是合法 probe variant`);
    }
    const effort = value.effort;
    if (effort !== null && effort !== undefined && !isEffort(effort)) {
        errors.push(`${label}.effort 不是合法档位或 null`);
    }
    if (value.error !== undefined && !isString(value.error)) {
        errors.push(`${label}.error 必须是字符串`);
    }
    if (typeof value.supported !== 'boolean' || !isString(variant) || !PROBE_VARIANTS.has(variant)) return null;
    return {
        supported: value.supported,
        variant,
        effort: isEffort(effort) ? effort : null,
        ...(isString(value.error) ? { error: value.error.slice(0, MAX_ERROR_SUMMARY_VALUE_LENGTH) } : {}),
    };
};

const resultV1Of = (value: unknown, index: number, errors: string[]): ProbeEffortResultV1 | null => {
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

const resultV2Of = (value: unknown, index: number, errors: string[]): ProbeEffortResultV2 | null => {
    if (!isRecord(value)) {
        errors.push(`results[${index}] 必须是对象`);
        return null;
    }
    const label = `results[${index}]`;
    const model = requiredStringOf(value.model, `${label}.model`, MAX_MODEL_ID_LENGTH, errors);
    const platform = value.platform;
    if (!isPlatform(platform)) {
        errors.push(`${label}.platform 不是已知平台`);
    }
    const lane = requiredStringOf(value.lane, `${label}.lane`, MAX_LANE_SIGNATURE_LENGTH, errors);
    const acceptedEfforts = acceptedEffortsOf(value.acceptedEfforts, `${label}.acceptedEfforts`, errors);
    const mappedEfforts =
        value.mappedEfforts === undefined
            ? []
            : acceptedEffortsOf(value.mappedEfforts, `${label}.mappedEfforts`, errors);
    const toggle = value.toggle;
    if (toggle !== null && typeof toggle !== 'boolean') {
        errors.push(`${label}.toggle 必须是布尔值或 null`);
    }
    const tools = toolsResultOf(value.tools, `${label}.tools`, errors);
    const errorSummary = errorSummaryOf(value.errorSummary, `${label}.errorSummary`, errors);
    const checkedOnRaw = value.checkedOn;
    const checkedOn = isString(checkedOnRaw) && isValidDate(checkedOnRaw) ? checkedOnRaw : null;
    if (checkedOn === null) errors.push(`${label}.checkedOn 必须是 YYYY-MM-DD 日期`);
    if (model === null || !isPlatform(platform) || lane === null || acceptedEfforts === null || mappedEfforts === null || checkedOn === null) {
        return null;
    }
    return {
        model,
        platform,
        lane,
        acceptedEfforts: sortEfforts(acceptedEfforts),
        mappedEfforts: sortEfforts(mappedEfforts),
        toggle: typeof toggle === 'boolean' ? toggle : null,
        tools,
        errorSummary,
        checkedOn,
    };
};

type MutableLaneFingerprints = { -readonly [Key in PlatformType]?: string };

const lanesMapOf = (value: unknown, errors: string[]): PlatformLaneFingerprints | null => {
    if (!isRecord(value)) {
        errors.push('lanes 必须是对象');
        return null;
    }
    const lanes: MutableLaneFingerprints = {};
    for (const [platform, fingerprint] of Object.entries(value)) {
        if (!isPlatform(platform)) {
            errors.push(`lanes.${platform} 不是已知平台`);
            continue;
        }
        const checked = requiredStringOf(fingerprint, `lanes.${platform}`, MAX_LANE_SIGNATURE_LENGTH, errors);
        if (checked !== null) lanes[platform] = checked;
    }
    return lanes;
};

/**
 * Parse and whitelist one v2 (or legacy v1) probe result document. Never throws:
 * a malformed or unsupported file yields all problems and no document, so the
 * command can explain every failure instead of a generic "格式错误".
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
    const schema = parsed.schema;
    if (schema !== PROBE_IMPORT_SCHEMA && schema !== PROBE_IMPORT_LEGACY_SCHEMA) {
        errors.push(`schema 必须是 ${PROBE_IMPORT_SCHEMA} 或 ${PROBE_IMPORT_LEGACY_SCHEMA}`);
        return { ok: false, errors };
    }
    const probedAt = isString(parsed.probedAt) && !Number.isNaN(Date.parse(parsed.probedAt)) ? parsed.probedAt : null;
    if (probedAt === null) errors.push('probedAt 不是 ISO 时间');

    const resultsRaw = parsed.results;
    if (!Array.isArray(resultsRaw)) {
        errors.push('results 必须是数组');
    } else if (resultsRaw.length > PROBE_IMPORT_MAX_RESULTS) {
        errors.push(`results 超过 ${PROBE_IMPORT_MAX_RESULTS} 条上限`);
    }

    if (schema === PROBE_IMPORT_LEGACY_SCHEMA) {
        const laneSignature = requiredStringOf(parsed.laneSignature, 'laneSignature', MAX_LANE_SIGNATURE_LENGTH, errors);
        const results: ProbeEffortResultV1[] = [];
        if (Array.isArray(resultsRaw) && resultsRaw.length <= PROBE_IMPORT_MAX_RESULTS) {
            resultsRaw.forEach((entry, index) => {
                const result = resultV1Of(entry, index, errors);
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
            return { ok: false, errors: ['文档头缺少 probedAt/laneSignature'] };
        }
        return {
            ok: true,
            document: { schema: 1, probedAt, laneSignature, results },
        };
    }

    const lanes = lanesMapOf(parsed.lanes, errors);
    const results: ProbeEffortResultV2[] = [];
    if (Array.isArray(resultsRaw) && resultsRaw.length <= PROBE_IMPORT_MAX_RESULTS) {
        resultsRaw.forEach((entry, index) => {
            const result = resultV2Of(entry, index, errors);
            if (result !== null) results.push(result);
        });
        const seen = new Set<string>();
        for (const result of results) {
            if (seen.has(result.model)) errors.push(`results 中 model 重复：${result.model}`);
            seen.add(result.model);
        }
    }
    if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS) };
    if (probedAt === null || lanes === null) {
        return { ok: false, errors: ['文档头缺少 probedAt/lanes'] };
    }
    return {
        ok: true,
        document: { schema: 2, probedAt, lanes, results },
    };
};

// ---------------------------------------------------------------------------
// Mapping onto capability proposals (§3.2 field-level provenance + lanes)
// ---------------------------------------------------------------------------

interface NormalizedProbeRow {
    readonly model: string;
    readonly platform: PlatformType;
    readonly lane: string;
    readonly acceptedEfforts: readonly ModelEffort[];
    readonly mappedEfforts: readonly ModelEffort[];
    readonly toggle: boolean | null;
    readonly tools: ProbeToolsResult | null;
    /** Only legacy v1 documents supply a defaultEffort; v2 leaves catalog's intact */
    readonly legacyDefaultEffort: ModelEffort | null | undefined;
    readonly checkedOn: string;
}

const legacyLanesOf = (laneSignature: string): PlatformLaneFingerprints => {
    const parts = laneSignature.split('|');
    if (parts.length !== PLATFORM_ORDER.length) return {};
    const lanes: MutableLaneFingerprints = {};
    PLATFORM_ORDER.forEach((platform, index) => {
        const part = parts[index];
        if (part !== undefined && part !== '') lanes[platform] = part;
    });
    return lanes;
};

const normalizedRowsOf = (document: ProbeResultDocument): {
    readonly lanes: PlatformLaneFingerprints;
    readonly rows: readonly NormalizedProbeRow[];
} => {
    if (document.schema === 2) {
        const lanes: MutableLaneFingerprints = { ...document.lanes };
        for (const row of document.results) lanes[row.platform] = row.lane;
        return {
            lanes,
            rows: document.results.map((row) => ({
                model: row.model,
                platform: row.platform,
                lane: row.lane,
                acceptedEfforts: row.acceptedEfforts,
                mappedEfforts: row.mappedEfforts,
                toggle: row.toggle,
                tools: row.tools,
                legacyDefaultEffort: undefined,
                checkedOn: row.checkedOn,
            })),
        };
    }
    const legacyLanes = legacyLanesOf(document.laneSignature);
    return {
        lanes: legacyLanes,
        rows: document.results.map((row) => {
            const platform = platformTypeOf(row.model);
            return {
                model: row.model,
                platform,
                lane: legacyLanes[platform] ?? document.laneSignature,
                acceptedEfforts: row.acceptedEfforts,
                mappedEfforts: [],
                toggle: row.toggle,
                tools: null,
                legacyDefaultEffort: row.defaultEffort,
                checkedOn: row.checkedOn,
            };
        }),
    };
};

/**
 * Build the updated `reasoning` section.
 * - v2 never writes `defaultEffort`: it preserves `current.reasoning?.defaultEffort`
 *   and only clears it to `null` if no longer in the measured `acceptedEfforts`.
 * - v2 only updates `toggle` when `row.toggle !== null` (toggle was actually tested).
 */
const reasoningOf = (
    current: ModelCatalogReasoning | undefined,
    row: NormalizedProbeRow,
    efforts: readonly ModelEffort[]
): ModelCatalogReasoning => {
    const candidateDefault =
        row.legacyDefaultEffort !== undefined
            ? row.legacyDefaultEffort
            : (current?.defaultEffort ?? null);
    const defaultEffort =
        candidateDefault !== null && efforts.some((effort) => effort === candidateDefault)
            ? candidateDefault
            : null;
    const toggle = row.toggle !== null ? row.toggle : current?.toggle;
    const supported = efforts.length > 0 || row.toggle === true || current?.supported === true;
    const defaultEnabled = toggle === true ? (current?.defaultEnabled ?? null) : null;
    return {
        supported,
        ...(toggle === undefined ? {} : { toggle }),
        efforts,
        defaultEffort,
        defaultEnabled,
        source: 'probe',
        checkedOn: row.checkedOn,
        confidence: PROBE_IMPORT_CONFIDENCE,
    };
};

const provenanceEntryEqual = (
    left: CapabilityFieldProvenance | undefined,
    right: CapabilityFieldProvenance | undefined
): boolean =>
    left?.source === right?.source &&
    left?.checkedOn === right?.checkedOn &&
    left?.confidence === right?.confidence &&
    left?.lane === right?.lane &&
    left?.ref === right?.ref;

/** Build field-level provenance entries ONLY for fields the probe actually measured (§3.2) */
const nextProvenanceOf = (
    current: ModelCatalogCapabilities,
    row: NormalizedProbeRow
): CapabilityProvenanceMap => {
    const base = current.provenance ?? deriveFieldProvenance(current);
    const probeEntry: CapabilityFieldProvenance = {
        source: 'probe',
        checkedOn: row.checkedOn,
        confidence: PROBE_IMPORT_CONFIDENCE,
        lane: row.lane,
    };
    return {
        ...base,
        'reasoning.supported': probeEntry,
        'reasoning.efforts': probeEntry,
        ...(row.toggle === null ? {} : { 'reasoning.toggle': probeEntry }),
    };
};

/** Whether probe-owned provenance or lane fingerprints moved */
const probeMetadataChanged = (
    current: ModelCatalogCapabilities,
    nextProvenance: CapabilityProvenanceMap,
    nextLanes: PlatformLaneFingerprints,
    row: NormalizedProbeRow,
    reasoning: ModelCatalogReasoning
): boolean => {
    if (
        current.reasoning?.source !== reasoning.source ||
        current.reasoning?.checkedOn !== reasoning.checkedOn ||
        current.reasoning?.confidence !== reasoning.confidence
    ) {
        return true;
    }
    if (current.laneFingerprints?.[row.platform] !== nextLanes[row.platform]) return true;
    const currentProv = current.provenance;
    if (currentProv === undefined) return true;
    if (!provenanceEntryEqual(currentProv['reasoning.supported'], nextProvenance['reasoning.supported'])) return true;
    if (!provenanceEntryEqual(currentProv['reasoning.efforts'], nextProvenance['reasoning.efforts'])) return true;
    if (row.toggle !== null && !provenanceEntryEqual(currentProv['reasoning.toggle'], nextProvenance['reasoning.toggle'])) {
        return true;
    }
    return false;
};

const noteOf = (changes: readonly string[], row: NormalizedProbeRow): string => {
    const extras: string[] = [];
    if (row.mappedEfforts.length > 0) extras.push(`mapped=${row.mappedEfforts.join('/')}`);
    if (row.tools !== null) {
        extras.push(row.tools.supported ? 'tools=ok' : `tools=fail(${row.tools.error ?? 'rejected'})`);
    }
    const detail = extras.length > 0 ? `；${extras.join('，')}` : '';
    if (changes.length === 0) {
        return `probe 导入：能力数据同步（lane ${row.lane}，${row.checkedOn}，置信 high${detail}）`;
    }
    const shown = changes.slice(0, 4).join('、');
    const more = changes.length > 4 ? ` 等 ${changes.length} 项` : '';
    return `probe 导入：${shown}${more}（lane ${row.lane}，${row.checkedOn}，置信 high${detail}）`;
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
    const { lanes, rows } = normalizedRowsOf(document);
    const proposals: PlannedProbeProposal[] = [];
    const skipped: ProbeImportSkip[] = [];
    const unchanged: string[] = [];

    for (const row of rows) {
        const entry = currentByModel.get(row.model);
        if (entry === undefined) {
            skipped.push({ model: row.model, reason: 'catalog 中没有该模型，无法生成能力提案' });
            continue;
        }
        if (!entry.enabled) {
            skipped.push({ model: row.model, reason: '模型未启用（enabled=0），跳过' });
            continue;
        }
        const current = entry.capabilities;
        const effortsSource = fieldProvenanceOf(current, 'reasoning.efforts')?.source ?? current.reasoning?.source;
        if (effortsSource === 'manual') {
            skipped.push({ model: row.model, reason: '思考档位由机主手改维护（manual 优先于 probe）' });
            continue;
        }
        if (effortsSource === 'official') {
            skipped.push({ model: row.model, reason: '思考档位由官方文档维护（official 优先于 probe）' });
            continue;
        }
        const efforts = sortEfforts(row.acceptedEfforts);
        const reasoning = reasoningOf(current.reasoning, row, efforts);
        const provenance = nextProvenanceOf(current, row);
        const laneFingerprints: PlatformLaneFingerprints = {
            ...current.laneFingerprints,
            [row.platform]: row.lane,
        };
        const payload: ModelCatalogCapabilities = {
            ...current,
            schema: 1,
            // Legacy mirror stays in sync for old readers
            reasoningEffort: efforts,
            reasoning,
            provenance,
            laneFingerprints,
        };
        const fieldChanges = capabilityFieldChangesOf(payload, current);
        const synced =
            fieldChanges.length === 0 &&
            !probeMetadataChanged(current, provenance, laneFingerprints, row, reasoning);
        if (synced) {
            unchanged.push(row.model);
            continue;
        }
        const changes = fieldChanges.map((change) => change.label);
        proposals.push({
            model: row.model,
            payload,
            baseline: current,
            note: noteOf(changes, row),
            checkedOn: row.checkedOn,
            changes,
        });
    }
    return { lanes, proposals, skipped, unchanged };
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

/**
 * Export the active chat menu from `model_catalog` + active prices into the
 * `--models-json` shape expected by `scripts/probe/thinking-effort.mts` (§3.6).
 * Unpriced models omit `price` so the probe CLI falls back to `FALLBACK_PRICE`.
 */
export const buildProbeModelsExport = (
    catalog: readonly ProbeCatalogModel[],
    priceOfModel: (model: string) => { readonly inputPerM: number; readonly outputPerM: number } | null
): readonly ProbeExportedModelEntry[] =>
    catalog
        .filter((entry) => entry.enabled && entry.capabilities.kind !== 'image')
        .map((entry) => {
            const reasoning = entry.capabilities.reasoning;
            const price = priceOfModel(entry.model);
            return {
                model: entry.model,
                platform: platformTypeOf(entry.model),
                enabled: true,
                vendorEfforts: reasoning?.efforts ?? [],
                vendorDefaultEffort: reasoning?.defaultEffort ?? null,
                vendorToggle: reasoning?.toggle === true,
                vendorDefaultEnabled: reasoning?.defaultEnabled ?? null,
                ...(price === null
                    ? {}
                    : { price: { inputPerMillionUsd: price.inputPerM, outputPerMillionUsd: price.outputPerM } }),
            };
        });
