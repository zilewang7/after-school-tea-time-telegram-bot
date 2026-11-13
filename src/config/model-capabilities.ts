/**
 * Model capability metadata, schema v1 (thinking-effort design 2026-1113-1742
 * §1.1). A `model_catalog` row keeps its seven legacy fields and may add the
 * optional sections upstream catalogs fill: reasoning, modalities, per-API
 * capabilities, and the seed-only tool-mixing facts.
 *
 * A missing field means "not known", never "no": only an explicit
 * `reasoning.supported === false` or a value the field's closed set names says
 * "no". Rows whose `schema !== 1` are read through the legacy path, where they
 * keep exactly the old field defaults and the runtime treats them as "no data".
 *
 * `normalizeModelCapabilities` is the only reader. It validates a parsed JSON
 * object, drops an unknown enum value at the smallest unit (one bad effort
 * loses that effort, not the whole reasoning section) and explains each drop in
 * `warnings`. It never throws.
 */
import { isJsonObject } from '../shared/json-object.js';

export type ModelCatalogKind = 'chat' | 'image';

export type ModelCatalogConfidence = 'high' | 'medium' | 'low';

/** Where a capability value came from: code seed, models.dev, owner edit, official docs or probe */
export const CAPABILITY_SOURCES = ['code', 'models-dev', 'manual', 'official', 'probe'] as const;
export type ModelCapabilitySource = (typeof CAPABILITY_SOURCES)[number];

/** The effort ladder, ascending: a user selection may be clamped down within it */
export const MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** Coarse modality classes, the order the panel lists them in */
export const MODEL_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** Gemini search × function-tool mixing: seed/manual knowledge, never a watcher proposal */
export type ModelToolsMixing = 'allowed' | 'denied' | 'unknown';

/** The provider APIs the catalog normalizes (models.dev `[api.*]` sections) */
export const MODEL_APIS = ['responses', 'chat-completions', 'messages', 'generate-content'] as const;
export type ModelApiName = (typeof MODEL_APIS)[number];

export interface ModelCatalogApiCapabilities {
    readonly reasoning?: boolean;
    readonly tools?: boolean;
    readonly structuredOutput?: boolean;
}

export type ModelCatalogApis = Partial<Record<ModelApiName, ModelCatalogApiCapabilities>>;

export interface ModelCatalogModalities {
    readonly input?: readonly ModelModality[];
    readonly output?: readonly ModelModality[];
}

export interface ModelCatalogReasoning {
    readonly supported: boolean;
    /** Supports turning thinking off/on; absent = not known */
    readonly toggle?: boolean;
    /** Effort values the model accepts; the ceiling of the menu's options */
    readonly efforts?: readonly ModelEffort[];
    /** Vendor default effort (display/clamp base only, never sent as a request); null = unknown */
    readonly defaultEffort?: ModelEffort | null;
    /** Vendor default enabled state of a toggle model; null = not applicable/unknown */
    readonly defaultEnabled?: boolean | null;
    readonly source?: ModelCapabilitySource;
    /** YYYY-MM-DD the section was checked against the source */
    readonly checkedOn?: string;
    readonly confidence?: ModelCatalogConfidence;
}

/** Local facts about Gemini's tool combinations and built-in tools; seed/manual only */
export interface ModelCatalogNativeTools {
    readonly imageSearchGrounding?: boolean;
}

/**
 * What one model can do. The first seven fields are the schema-1 legacy shape
 * (old code reads them); every section below is optional because an absent
 * section is "not known" rather than "unsupported".
 */
export interface ModelCatalogCapabilities {
    /** Only 1 is interpreted at runtime; absent/other = legacy row, code fallback */
    readonly schema?: 1;
    readonly kind: ModelCatalogKind;
    /** Accepts image input */
    readonly vision: boolean;
    /** Emits images (image-generation models) */
    readonly imageOutput: boolean;
    /** Function/tool calling */
    readonly tools: boolean;
    /** Legacy mirror of `reasoning.efforts`, kept for old readers */
    readonly reasoningEffort: readonly string[];
    /** Context window in tokens; null = unknown */
    readonly contextTokens: number | null;
    /** Max output tokens in tokens; null = unknown */
    readonly outputTokens: number | null;
    readonly modalities?: ModelCatalogModalities;
    readonly reasoning?: ModelCatalogReasoning;
    readonly apis?: ModelCatalogApis;
    readonly toolsMixing?: ModelToolsMixing;
    readonly nativeTools?: ModelCatalogNativeTools;
    readonly source?: ModelCapabilitySource;
    readonly checkedOn?: string;
    readonly confidence?: ModelCatalogConfidence;
}

export interface ModelCapabilitiesNormalization {
    readonly capabilities: ModelCatalogCapabilities;
    readonly warnings: readonly string[];
}

/** The schema-1 shape with nothing known beyond the legacy defaults */
export const emptyModelCapabilities = (): ModelCatalogCapabilities => ({
    kind: 'chat',
    vision: false,
    imageOutput: false,
    tools: true,
    reasoningEffort: [],
    contextTokens: null,
    outputTokens: null,
});

/** A free-form value dropped with a warning ("the smallest unit") */
const MAX_TOKEN_LIMIT = 10_000_000;

const EFFORT_SET: ReadonlySet<string> = new Set(MODEL_EFFORTS);
const EFFORT_RANK: Readonly<Record<ModelEffort, number>> = {
    none: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
    ultra: 7,
};
const MODALITY_SET: ReadonlySet<string> = new Set(MODEL_MODALITIES);
const MODALITY_RANK: Readonly<Record<ModelModality, number>> = {
    text: 0,
    image: 1,
    audio: 2,
    video: 3,
    pdf: 4,
};
const MIME_PREFIXES: readonly (readonly [string, ModelModality])[] = [
    ['image/', 'image'],
    ['audio/', 'audio'],
    ['video/', 'video'],
];
const TOOLS_MIXING_SET: ReadonlySet<string> = new Set(['allowed', 'denied', 'unknown']);
const CAPABILITY_SOURCE_SET: ReadonlySet<string> = new Set(CAPABILITY_SOURCES);
const CONFIDENCE_SET: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const CHECKED_ON = /^\d{4}-\d{2}-\d{2}$/;

const isString = (value: unknown): value is string => typeof value === 'string';

export const isModelEffort = (value: unknown): value is ModelEffort => isString(value) && EFFORT_SET.has(value);

const isModelModality = (value: unknown): value is ModelModality =>
    isString(value) && MODALITY_SET.has(value);

const isToolsMixing = (value: unknown): value is ModelToolsMixing =>
    isString(value) && TOOLS_MIXING_SET.has(value);

const isCapabilitySource = (value: unknown): value is ModelCapabilitySource =>
    isString(value) && CAPABILITY_SOURCE_SET.has(value);

const isConfidence = (value: unknown): value is ModelCatalogConfidence =>
    isString(value) && CONFIDENCE_SET.has(value);

/** MIME or a coarse class → coarse class; null = unknown MIME */
const coarseModalityOf = (value: string): ModelModality | null => {
    const mime = value.trim().toLowerCase();
    if (isModelModality(mime)) return mime;
    if (mime === 'text/plain') return 'text';
    if (mime === 'application/pdf') return 'pdf';
    const prefix = MIME_PREFIXES.find(([mimePrefix]) => mime.startsWith(mimePrefix));
    return prefix === undefined ? null : prefix[1];
};

const sortEfforts = (values: readonly ModelEffort[]): readonly ModelEffort[] =>
    [...values].sort((first, second) => EFFORT_RANK[first] - EFFORT_RANK[second]);

const sortModalities = (values: readonly ModelModality[]): readonly ModelModality[] =>
    [...values].sort((first, second) => MODALITY_RANK[first] - MODALITY_RANK[second]);

/** A typed boolean or undefined when absent; a wrong type is dropped with a warning */
const booleanOf = (value: unknown, label: string, warnings: string[]): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    warnings.push(`${label} 不是布尔值，按未知处理`);
    return undefined;
};

/** Effort list: closed-set filter, dedupe, ascending order; unknown values drop one by one */
export const normalizeEffortList = (value: unknown, label: string, warnings: string[]): readonly ModelEffort[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        warnings.push(`${label} 不是数组，按未知处理`);
        return undefined;
    }
    const efforts = new Set<ModelEffort>();
    for (const item of value) {
        if (isModelEffort(item)) {
            efforts.add(item);
            continue;
        }
        warnings.push(`${label} 的未知档位（${String(item)}）已丢弃`);
    }
    return sortEfforts([...efforts]);
};

/** Modality list: MIME → coarse class, unknown entries drop one by one; empty = unknown */
export const coarseModalitiesOf = (value: unknown, label: string, warnings: string[]): readonly ModelModality[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        warnings.push(`${label} 不是数组，按未知处理`);
        return undefined;
    }
    const modalities = new Set<ModelModality>();
    for (const item of value) {
        if (!isString(item)) {
            warnings.push(`${label} 的未知模态（${String(item)}）已丢弃`);
            continue;
        }
        const modality = coarseModalityOf(item);
        if (modality === null) {
            warnings.push(`${label} 的未知模态（${item}）已丢弃`);
            continue;
        }
        modalities.add(modality);
    }
    if (modalities.size === 0) {
        warnings.push(`${label} 没有可识别的模态，按未知处理`);
        return undefined;
    }
    return sortModalities([...modalities]);
};

/** Token limit: a positive integer below the sanity ceiling; anything else = null (unknown) */
export const tokenLimitOf = (value: unknown, label: string, warnings: string[]): number | null => {
    if (value === undefined || value === null) return null;
    const valid = typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_TOKEN_LIMIT;
    if (!valid) {
        warnings.push(`${label} 不是 1..${MAX_TOKEN_LIMIT} 的整数，按未知处理`);
        return null;
    }
    return value;
};

const checkedOnOf = (value: unknown, label: string, warnings: string[]): string | undefined => {
    if (value === undefined) return undefined;
    if (isString(value) && CHECKED_ON.test(value)) return value;
    warnings.push(`${label} 不是 YYYY-MM-DD，已丢弃`);
    return undefined;
};

const capabilitySourceOf = (
    value: unknown,
    label: string,
    warnings: string[]
): ModelCapabilitySource | undefined => {
    if (value === undefined) return undefined;
    if (isCapabilitySource(value)) return value;
    warnings.push(`${label} 不是已知来源，已丢弃`);
    return undefined;
};

const confidenceOf = (
    value: unknown,
    label: string,
    warnings: string[]
): ModelCatalogConfidence | undefined => {
    if (value === undefined) return undefined;
    if (isConfidence(value)) return value;
    warnings.push(`${label} 不是 high/medium/low，已丢弃`);
    return undefined;
};

interface ProvenanceFields {
    readonly source?: ModelCapabilitySource;
    readonly checkedOn?: string;
    readonly confidence?: ModelCatalogConfidence;
}

/** The provenance triple, each field kept only when valid */
const provenanceOf = (record: Record<string, unknown>, label: string, warnings: string[]): ProvenanceFields => {
    const source = capabilitySourceOf(record.source, `${label}.source`, warnings);
    const checkedOn = checkedOnOf(record.checkedOn, `${label}.checkedOn`, warnings);
    const confidence = confidenceOf(record.confidence, `${label}.confidence`, warnings);
    return {
        ...(source === undefined ? {} : { source }),
        ...(checkedOn === undefined ? {} : { checkedOn }),
        ...(confidence === undefined ? {} : { confidence }),
    };
};

/** The vendor default effort: kept only when the effort list contains it */
const defaultEffortOf = (value: unknown, efforts: readonly ModelEffort[], warnings: string[]): ModelEffort | null => {
    if (value === undefined || value === null) return null;
    if (!isModelEffort(value)) {
        warnings.push(`reasoning.defaultEffort 的未知档位（${String(value)}）已丢弃`);
        return null;
    }
    if (!efforts.includes(value)) {
        warnings.push(`reasoning.defaultEffort（${value}）不在 efforts 内，置 null`);
        return null;
    }
    return value;
};

/** The vendor default enabled state; only meaningful for a toggle model */
const defaultEnabledOf = (value: unknown, toggle: boolean | undefined, warnings: string[]): boolean | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') {
        warnings.push('reasoning.defaultEnabled 不是布尔值，按未知处理');
        return null;
    }
    if (toggle !== true) {
        warnings.push('reasoning.defaultEnabled 只对可开关模型有意义，置 null');
        return null;
    }
    return value;
};

const normalizeReasoning = (value: unknown, warnings: string[]): ModelCatalogReasoning | undefined => {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
        warnings.push('reasoning 不是对象，已忽略');
        return undefined;
    }
    const supported = booleanOf(value.supported, 'reasoning.supported', warnings);
    if (supported === undefined) {
        warnings.push('reasoning 缺少 supported，已忽略');
        return undefined;
    }
    const provenance = provenanceOf(value, 'reasoning', warnings);
    if (!supported) {
        // A model without reasoning accepts no effort and has no default
        return { supported: false, efforts: [], defaultEffort: null, defaultEnabled: null, ...provenance };
    }
    const toggle = booleanOf(value.toggle, 'reasoning.toggle', warnings);
    const efforts = normalizeEffortList(value.efforts, 'reasoning.efforts', warnings);
    return {
        supported,
        ...(toggle === undefined ? {} : { toggle }),
        ...(efforts === undefined ? {} : { efforts }),
        defaultEffort: defaultEffortOf(value.defaultEffort, efforts ?? [], warnings),
        defaultEnabled: defaultEnabledOf(value.defaultEnabled, toggle, warnings),
        ...provenance,
    };
};

const normalizeModalities = (value: unknown, warnings: string[]): ModelCatalogModalities | undefined => {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
        warnings.push('modalities 不是对象，已忽略');
        return undefined;
    }
    const input = coarseModalitiesOf(value.input, 'modalities.input', warnings);
    const output = coarseModalitiesOf(value.output, 'modalities.output', warnings);
    if (input === undefined && output === undefined) return undefined;
    return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
};

const normalizeApiFlags = (
    value: unknown,
    label: string,
    warnings: string[]
): ModelCatalogApiCapabilities | undefined => {
    if (!isJsonObject(value)) {
        warnings.push(`${label} 不是对象，已忽略`);
        return undefined;
    }
    const reasoning = booleanOf(value.reasoning, `${label}.reasoning`, warnings);
    const tools = booleanOf(value.tools, `${label}.tools`, warnings);
    const structuredOutput = booleanOf(value.structuredOutput, `${label}.structuredOutput`, warnings);
    if (reasoning === undefined && tools === undefined && structuredOutput === undefined) return undefined;
    return {
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(tools === undefined ? {} : { tools }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
    };
};

type MutableApis = { -readonly [Key in ModelApiName]?: ModelCatalogApiCapabilities };

const normalizeApis = (value: unknown, warnings: string[]): ModelCatalogApis | undefined => {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
        warnings.push('apis 不是对象，已忽略');
        return undefined;
    }
    const apis: MutableApis = {};
    for (const name of MODEL_APIS) {
        const apiValue = value[name];
        if (apiValue === undefined) continue;
        const flags = normalizeApiFlags(apiValue, `apis.${name}`, warnings);
        if (flags !== undefined) apis[name] = flags;
    }
    return Object.keys(apis).length === 0 ? undefined : apis;
};

const normalizeNativeTools = (value: unknown, warnings: string[]): ModelCatalogNativeTools | undefined => {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
        warnings.push('nativeTools 不是对象，已忽略');
        return undefined;
    }
    const imageSearchGrounding = booleanOf(value.imageSearchGrounding, 'nativeTools.imageSearchGrounding', warnings);
    return imageSearchGrounding === undefined ? undefined : { imageSearchGrounding };
};

const normalizeToolsMixing = (value: unknown, warnings: string[]): ModelToolsMixing | undefined => {
    if (value === undefined) return undefined;
    if (isToolsMixing(value)) return value;
    warnings.push(`toolsMixing（${String(value)}）未知，已丢弃`);
    return undefined;
};

/** The old seven-field reader: rows without `schema: 1` keep exactly their old defaults */
const normalizeLegacy = (record: Record<string, unknown>, warnings: string[]): ModelCatalogCapabilities => {
    if (record.kind !== undefined && record.kind !== 'chat' && record.kind !== 'image') {
        warnings.push(`kind（${String(record.kind)}）未知，按 chat 处理`);
    }
    const legacyEfforts = record.reasoningEffort;
    if (legacyEfforts !== undefined && !Array.isArray(legacyEfforts)) {
        warnings.push('reasoningEffort 不是数组，按空处理');
    }
    const legacyNumber = (key: string): number | null => {
        const value = record[key];
        if (typeof value === 'number') return value;
        if (value !== undefined && value !== null) warnings.push(`${key} 不是数字，按未知处理`);
        return null;
    };
    return {
        kind: record.kind === 'image' ? 'image' : 'chat',
        vision: booleanOf(record.vision, 'vision', warnings) ?? false,
        imageOutput: booleanOf(record.imageOutput, 'imageOutput', warnings) ?? false,
        tools: booleanOf(record.tools, 'tools', warnings) ?? true,
        reasoningEffort: Array.isArray(legacyEfforts) ? legacyEfforts.filter(isString) : [],
        contextTokens: legacyNumber('contextTokens'),
        outputTokens: legacyNumber('outputTokens'),
    };
};

/** Normalize one `model_catalog.capabilities` JSON value; never throws */
export const normalizeModelCapabilities = (raw: unknown): ModelCapabilitiesNormalization => {
    const warnings: string[] = [];
    if (!isJsonObject(raw)) {
        return {
            capabilities: emptyModelCapabilities(),
            warnings: ['capabilities 不是 JSON 对象，按空能力处理'],
        };
    }
    if (raw.schema !== 1) {
        // Rule: non-v1 rows are read as legacy data; the runtime later falls back to code
        if (raw.schema !== undefined) {
            warnings.push(`capabilities.schema 是 ${String(raw.schema)}，只认识 1，按旧格式读取`);
        }
        return { capabilities: normalizeLegacy(raw, warnings), warnings };
    }
    const reasoning = normalizeReasoning(raw.reasoning, warnings);
    const modalities = normalizeModalities(raw.modalities, warnings);
    if (raw.kind !== undefined && raw.kind !== 'chat' && raw.kind !== 'image') {
        warnings.push(`kind（${String(raw.kind)}）未知，改由模态派生`);
    }
    const explicitKind = raw.kind === 'image' ? 'image' : raw.kind === 'chat' ? 'chat' : undefined;
    const imageOutput =
        booleanOf(raw.imageOutput, 'imageOutput', warnings) ?? modalities?.output?.includes('image') ?? false;
    const vision = booleanOf(raw.vision, 'vision', warnings) ?? modalities?.input?.includes('image') ?? false;
    const tools = booleanOf(raw.tools, 'tools', warnings) ?? true;
    const mirroredEfforts =
        reasoning?.efforts === undefined
            ? (normalizeEffortList(raw.reasoningEffort, 'reasoningEffort', warnings) ?? [])
            : reasoning.efforts;
    const apis = normalizeApis(raw.apis, warnings);
    const toolsMixing = normalizeToolsMixing(raw.toolsMixing, warnings);
    const nativeTools = normalizeNativeTools(raw.nativeTools, warnings);
    const provenance = provenanceOf(raw, 'capabilities', warnings);
    return {
        capabilities: {
            schema: 1,
            kind: explicitKind ?? (imageOutput ? 'image' : 'chat'),
            vision,
            imageOutput,
            tools,
            reasoningEffort: mirroredEfforts,
            contextTokens: tokenLimitOf(raw.contextTokens, 'contextTokens', warnings),
            outputTokens: tokenLimitOf(raw.outputTokens, 'outputTokens', warnings),
            ...(modalities === undefined ? {} : { modalities }),
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(apis === undefined ? {} : { apis }),
            ...(toolsMixing === undefined ? {} : { toolsMixing }),
            ...(nativeTools === undefined ? {} : { nativeTools }),
            ...provenance,
        },
        warnings,
    };
};
