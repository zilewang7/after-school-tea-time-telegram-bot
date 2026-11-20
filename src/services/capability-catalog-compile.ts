/**
 * The capability compiler and differ of the watch run (thinking-effort design
 * 2026-1113-1742 §2.3): reads the models.dev documents the price pipeline has
 * already downloaded (provider TOML, canonical lab TOML, `api.json`) and turns
 * them into partial `CapabilityPatch` values, then overlays those onto the
 * catalog's current capabilities to draft the proposals the owner approves.
 *
 * Sources and precedence, highest first: provider TOML > canonical lab TOML >
 * `api.json` (design §2.1). A field a document does not name is not asserted,
 * so "missing upstream" can never become "cleared locally".
 *
 * Everything here is pure: no clock (the run's `now` is passed in), no network,
 * no database. A broken document becomes a warning, never an exception, so one
 * changed upstream file cannot cost the owner the whole run.
 */
import { parse as parseToml } from 'smol-toml';
import { isJsonObject } from '../shared/json-object.js';
import {
    coarseModalitiesOf,
    deriveFieldProvenance,
    fieldProvenanceOf,
    isModelEffort,
    MODEL_APIS,
    MODEL_MODALITIES,
    normalizeEffortList,
    tokenLimitOf,
    type CapabilityFieldProvenance,
    type CapabilityProvenanceMap,
    type ModelApiName,
    type ModelCatalogApiCapabilities,
    type ModelCatalogApis,
    type ModelCatalogCapabilities,
    type ModelCatalogKind,
    type ModelCatalogModalities,
    type ModelCatalogReasoning,
    type ModelCapabilitySource,
    type ModelEffort,
    type ModelModality,
    type PlatformLaneFingerprints,
} from '../config/model-capabilities.js';
import { platformOfModelId, type ModelCatalogEntry } from '../config/model-catalog.js';
import type { ReplyMetricCapabilityEventRow } from '../db/queries/reply-metrics.js';
import { catalogModelRefs } from './price-catalog-fetch.js';
import type { CatalogDocuments, CatalogModelRef } from './price-catalog-types.js';
import {
    CAPABILITY_PROPOSAL_CONFIDENCE,
    CAPABILITY_UPSTREAM_SOURCE,
    MAX_CAPABILITY_PROPOSALS_PER_RUN,
    type CapabilityCandidate,
    type CapabilityCompileOptions,
    type CapabilityCompileResult,
    type CapabilityDiffOptions,
    type CapabilityDiffResult,
    type CapabilityFieldChange,
    type CapabilityObservationOrigin,
    type CapabilityPatch,
    type CapabilityProposalDraft,
    type CapabilityReasoningPatch,
} from './capability-catalog-types.js';

type TomlNode = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is TomlNode =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const nodeOf = (value: unknown): TomlNode | null => (isNode(value) ? value : null);

/** An optional TOML table: absent is quiet, present-but-wrong is a warning */
const nodeOrWarn = (value: unknown, label: string, warnings: string[]): TomlNode | null => {
    if (value === undefined) return null;
    const node = nodeOf(value);
    if (node === null) warnings.push(`${label} 不是对象，已忽略`);
    return node;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A typed boolean or undefined when absent; a wrong type is dropped with a warning */
const booleanOf = (value: unknown, label: string, warnings: string[]): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    warnings.push(`${label} 不是布尔值，已丢弃`);
    return undefined;
};

/** Prefer the higher-priority value; `undefined` means "not asserted" (null is a value) */
const prefer = <T>(higher: T | undefined, lower: T | undefined): T | undefined =>
    higher === undefined ? lower : higher;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Patch merging (the priority chain)
// ---------------------------------------------------------------------------

type MutableApis = { -readonly [Key in ModelApiName]?: ModelCatalogApiCapabilities };

const mergeApiFlags = (
    lower: ModelCatalogApiCapabilities | undefined,
    higher: ModelCatalogApiCapabilities | undefined
): ModelCatalogApiCapabilities | undefined => {
    if (lower === undefined) return higher;
    if (higher === undefined) return lower;
    const reasoning = prefer(higher.reasoning, lower.reasoning);
    const tools = prefer(higher.tools, lower.tools);
    const structuredOutput = prefer(higher.structuredOutput, lower.structuredOutput);
    return {
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(tools === undefined ? {} : { tools }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
    };
};

const mergeApis = (lower: ModelCatalogApis | undefined, higher: ModelCatalogApis | undefined): ModelCatalogApis | undefined => {
    if (lower === undefined) return higher;
    if (higher === undefined) return lower;
    const apis: MutableApis = {};
    for (const name of MODEL_APIS) {
        const flags = mergeApiFlags(lower[name], higher[name]);
        if (flags !== undefined) apis[name] = flags;
    }
    return Object.keys(apis).length === 0 ? undefined : apis;
};

const mergeModalities = (
    lower: ModelCatalogModalities | undefined,
    higher: ModelCatalogModalities | undefined
): ModelCatalogModalities | undefined => {
    const input = prefer(higher?.input, lower?.input);
    const output = prefer(higher?.output, lower?.output);
    if (input === undefined && output === undefined) return undefined;
    return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
};

const mergeReasoningPatch = (
    lower: CapabilityReasoningPatch | undefined,
    higher: CapabilityReasoningPatch | undefined
): CapabilityReasoningPatch | undefined => {
    if (lower === undefined) return higher;
    if (higher === undefined) return lower;
    const supported = prefer(higher.supported, lower.supported);
    const toggle = prefer(higher.toggle, lower.toggle);
    const efforts = prefer(higher.efforts, lower.efforts);
    const defaultEffort = prefer(higher.defaultEffort, lower.defaultEffort);
    const defaultEnabled = prefer(higher.defaultEnabled, lower.defaultEnabled);
    return {
        ...(supported === undefined ? {} : { supported }),
        ...(toggle === undefined ? {} : { toggle }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    };
};

/** Merge two partial patches; every builder omits unknown fields, so spread is enough */
const mergePatches = (lower: CapabilityPatch, higher: CapabilityPatch): CapabilityPatch => ({
    ...lower,
    ...higher,
    modalities: mergeModalities(lower.modalities, higher.modalities),
    reasoning: mergeReasoningPatch(lower.reasoning, higher.reasoning),
    apis: mergeApis(lower.apis, higher.apis),
});

const isEmptyPatch = (patch: CapabilityPatch): boolean =>
    patch.kind === undefined &&
    patch.vision === undefined &&
    patch.imageOutput === undefined &&
    patch.tools === undefined &&
    patch.contextTokens === undefined &&
    patch.outputTokens === undefined &&
    patch.modalities === undefined &&
    patch.reasoning === undefined &&
    patch.apis === undefined;

// ---------------------------------------------------------------------------
// Evidence: one document's assertions plus what only that document knows
// ---------------------------------------------------------------------------

interface CapabilityEvidence {
    readonly patch: CapabilityPatch;
    readonly origins: readonly CapabilityObservationOrigin[];
    /** Top-level structured-output support, only used to fill the per-API subset */
    readonly structuredOutput?: boolean;
    /** Provider API sections present; only the provider TOML names them */
    readonly apiNames: readonly ModelApiName[];
}

const NO_EVIDENCE: CapabilityEvidence = { patch: {}, origins: [], apiNames: [] };

const evidenceOf = (
    origin: CapabilityObservationOrigin,
    patch: CapabilityPatch,
    extras: { readonly structuredOutput?: boolean; readonly apiNames?: readonly ModelApiName[] } = {}
): CapabilityEvidence => ({
    patch,
    origins: isEmptyPatch(patch) && (extras.apiNames ?? []).length === 0 ? [] : [origin],
    ...(extras.structuredOutput === undefined ? {} : { structuredOutput: extras.structuredOutput }),
    apiNames: extras.apiNames ?? [],
});

const mergeEvidence = (lower: CapabilityEvidence, higher: CapabilityEvidence): CapabilityEvidence => {
    const structuredOutput = prefer(higher.structuredOutput, lower.structuredOutput);
    return {
        patch: mergePatches(lower.patch, higher.patch),
        origins: [...new Set([...higher.origins, ...lower.origins])],
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        apiNames: higher.apiNames.length > 0 ? higher.apiNames : lower.apiNames,
    };
};

const modalitiesPatchOf = (node: TomlNode, modelId: string, warnings: string[]): ModelCatalogModalities | undefined => {
    const input = coarseModalitiesOf(node.input, `${modelId}：modalities.input`, warnings);
    const output = coarseModalitiesOf(node.output, `${modelId}：modalities.output`, warnings);
    if (input === undefined && output === undefined) return undefined;
    return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
};

const limitsPatchOf = (node: TomlNode, modelId: string, warnings: string[]): Pick<
    CapabilityPatch,
    'contextTokens' | 'outputTokens'
> => {
    const contextTokens = tokenLimitOf(node.context, `${modelId}：limit.context`, warnings) ?? undefined;
    const outputTokens = tokenLimitOf(node.output, `${modelId}：limit.output`, warnings) ?? undefined;
    return {
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
    };
};

// ---------------------------------------------------------------------------
// Provider TOML (the model's page inside our route's provider directory)
// ---------------------------------------------------------------------------

const providerReasoningPatch = (
    capabilities: TomlNode,
    modelId: string,
    warnings: string[]
): CapabilityReasoningPatch | undefined => {
    const reasoning = nodeOf(capabilities.reasoning);
    if (reasoning === null) return undefined;
    const supported = booleanOf(reasoning.supported, `${modelId}：reasoning.supported`, warnings);
    const toggle = booleanOf(reasoning.toggle, `${modelId}：reasoning.toggle`, warnings);
    const efforts = normalizeEffortList(reasoning.effort, `${modelId}：reasoning.effort`, warnings);
    let defaultEffort: ModelEffort | undefined;
    let defaultEnabled: boolean | undefined;
    const defaultNode = nodeOf(reasoning.default);
    if (defaultNode !== null) {
        const type = defaultNode.type;
        const value = defaultNode.value;
        if (type === 'effort') {
            if (isModelEffort(value)) {
                defaultEffort = value;
                // A default effort means the vendor default is "on"
                if (toggle === true) defaultEnabled = true;
            } else {
                warnings.push(`${modelId}：reasoning.default 的档位未知（${String(value)}），已丢弃`);
            }
        } else if (type === 'toggle') {
            if (typeof value === 'boolean') defaultEnabled = value;
            else warnings.push(`${modelId}：reasoning.default 的开关值未知（${String(value)}），已丢弃`);
        } else {
            warnings.push(`${modelId}：reasoning.default 的形状未知（${String(type)}），已忽略`);
        }
    }
    const patch: CapabilityReasoningPatch = {
        ...(supported === undefined ? {} : { supported }),
        ...(toggle === undefined ? {} : { toggle }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    };
    return Object.keys(patch).length === 0 ? undefined : patch;
};

const providerTomlEvidenceOf = (body: string, modelId: string, warnings: string[]): CapabilityEvidence | null => {
    let parsed: unknown;
    try {
        parsed = parseToml(body);
    } catch (error) {
        warnings.push(`${modelId}：provider TOML 解析失败（${messageOf(error)}）`);
        return null;
    }
    const root = nodeOf(parsed);
    if (root === null) {
        warnings.push(`${modelId}：provider TOML 不是一个对象，跳过`);
        return null;
    }
    const capabilities = nodeOrWarn(root.capabilities, `${modelId}：provider [capabilities]`, warnings);
    const reasoning = capabilities === null ? undefined : providerReasoningPatch(capabilities, modelId, warnings);
    const toolsNode = capabilities === null ? null : nodeOf(capabilities.tools);
    const tools = toolsNode === null ? undefined : booleanOf(toolsNode.supported, `${modelId}：tools.supported`, warnings);
    const structuredOutput =
        capabilities === null
            ? undefined
            : booleanOf(capabilities.structured_output, `${modelId}：structured_output`, warnings);
    const modalitiesNode = nodeOrWarn(root.modalities, `${modelId}：provider [modalities]`, warnings);
    const modalities = modalitiesNode === null ? undefined : modalitiesPatchOf(modalitiesNode, modelId, warnings);
    const limitNode = nodeOrWarn(root.limit, `${modelId}：provider [limit]`, warnings);
    const limits = limitNode === null ? {} : limitsPatchOf(limitNode, modelId, warnings);
    const apiNode = nodeOrWarn(root.api, `${modelId}：provider [api]`, warnings);
    const apiNames = apiNode === null ? [] : MODEL_APIS.filter((name) => apiNode[name] !== undefined);
    const patch: CapabilityPatch = {
        ...(tools === undefined ? {} : { tools }),
        ...(modalities === undefined ? {} : { modalities }),
        ...limits,
        ...(reasoning === undefined ? {} : { reasoning }),
    };
    return evidenceOf('provider-toml', patch, {
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        apiNames,
    });
};

// ---------------------------------------------------------------------------
// Canonical lab TOML (limits and the full MIME modality list)
// ---------------------------------------------------------------------------

const labTomlEvidenceOf = (body: string, modelId: string, warnings: string[]): CapabilityEvidence | null => {
    let parsed: unknown;
    try {
        parsed = parseToml(body);
    } catch (error) {
        warnings.push(`${modelId}：canonical lab TOML 解析失败（${messageOf(error)}）`);
        return null;
    }
    const root = nodeOf(parsed);
    if (root === null) {
        warnings.push(`${modelId}：canonical lab TOML 不是一个对象，跳过`);
        return null;
    }
    const modalitiesNode = nodeOrWarn(root.modalities, `${modelId}：lab [modalities]`, warnings);
    const modalities = modalitiesNode === null ? undefined : modalitiesPatchOf(modalitiesNode, modelId, warnings);
    const limitNode = nodeOrWarn(root.limit, `${modelId}：lab [limit]`, warnings);
    const limits = limitNode === null ? {} : limitsPatchOf(limitNode, modelId, warnings);
    const capabilities = nodeOrWarn(root.capabilities, `${modelId}：lab [capabilities]`, warnings);
    const toolsNode = capabilities === null ? null : nodeOf(capabilities.tools);
    const tools = toolsNode === null ? undefined : booleanOf(toolsNode.supported, `${modelId}：lab tools.supported`, warnings);
    const reasoningNode = capabilities === null ? null : nodeOf(capabilities.reasoning);
    const reasoningSupported =
        reasoningNode === null
            ? undefined
            : booleanOf(reasoningNode.supported, `${modelId}：lab reasoning.supported`, warnings);
    const structuredOutput =
        capabilities === null
            ? undefined
            : booleanOf(capabilities.structured_output, `${modelId}：lab structured_output`, warnings);
    const patch: CapabilityPatch = {
        ...(tools === undefined ? {} : { tools }),
        ...(modalities === undefined ? {} : { modalities }),
        ...limits,
        ...(reasoningSupported === undefined ? {} : { reasoning: { supported: reasoningSupported } }),
    };
    return evidenceOf('lab-toml', patch, { structuredOutput });
};

// ---------------------------------------------------------------------------
// api.json (the aggregate: limits fallback, coarse modalities, kind, flat flags)
// ---------------------------------------------------------------------------

const apiJsonReasoningPatch = (model: TomlNode, modelId: string, warnings: string[]): CapabilityReasoningPatch | undefined => {
    const supported = booleanOf(model.reasoning, `${modelId}：api.json reasoning`, warnings);
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
    let efforts: readonly ModelEffort[] | undefined;
    let toggle: boolean | undefined;
    for (const option of options) {
        const node = nodeOf(option);
        if (node === null) continue;
        if (node.type === 'effort' && efforts === undefined) {
            efforts = normalizeEffortList(node.values, `${modelId}：api.json effort`, warnings);
            continue;
        }
        if (node.type === 'toggle') toggle = true;
    }
    const patch: CapabilityReasoningPatch = {
        ...(supported === undefined ? {} : { supported }),
        ...(toggle === undefined ? {} : { toggle }),
        ...(efforts === undefined ? {} : { efforts }),
    };
    return Object.keys(patch).length === 0 ? undefined : patch;
};

const kindOfApiJson = (model: TomlNode, modelId: string, warnings: string[]): ModelCatalogKind | undefined => {
    const type = model.type;
    if (type === 'image') return 'image';
    if (type === 'chat') return 'chat';
    if (type !== undefined) warnings.push(`${modelId}：api.json type（${String(type)}）未知，不用于 kind`);
    return undefined;
};

const apiJsonEvidenceOf = (model: TomlNode, modelId: string, warnings: string[]): CapabilityEvidence => {
    const kind = kindOfApiJson(model, modelId, warnings);
    const reasoning = apiJsonReasoningPatch(model, modelId, warnings);
    const tools = booleanOf(model.tool_call, `${modelId}：api.json tool_call`, warnings);
    const structuredOutput = booleanOf(model.structured_output, `${modelId}：api.json structured_output`, warnings);
    const modalitiesNode = nodeOrWarn(model.modalities, `${modelId}：api.json modalities`, warnings);
    const modalities = modalitiesNode === null ? undefined : modalitiesPatchOf(modalitiesNode, modelId, warnings);
    const limitNode = nodeOrWarn(model.limit, `${modelId}：api.json limit`, warnings);
    const limits = limitNode === null ? {} : limitsPatchOf(limitNode, modelId, warnings);
    const patch: CapabilityPatch = {
        ...(kind === undefined ? {} : { kind }),
        ...(tools === undefined ? {} : { tools }),
        ...(modalities === undefined ? {} : { modalities }),
        ...limits,
        ...(reasoning === undefined ? {} : { reasoning }),
    };
    return evidenceOf('api-json', patch, { structuredOutput });
};

/** The aggregate model of one ref; null when the provider/model is not listed */
const apiJsonModelOf = (root: TomlNode, ref: CatalogModelRef): TomlNode | null => {
    if (ref.modelFile === '') return null;
    const provider = nodeOf(root[ref.provider]);
    const models = provider === null ? null : nodeOf(provider.models);
    return models === null ? null : nodeOf(models[ref.modelFile]);
};

// ---------------------------------------------------------------------------
// Compile: merge the evidence and complete the derived fields
// ---------------------------------------------------------------------------

const clampReasoningPatch = (
    reasoning: CapabilityReasoningPatch | undefined,
    modelId: string,
    warnings: string[]
): CapabilityReasoningPatch | undefined => {
    if (reasoning === undefined) return undefined;
    if (reasoning.supported === false) {
        return { supported: false, efforts: [], defaultEffort: null, defaultEnabled: null };
    }
    const { defaultEffort, efforts } = reasoning;
    if (defaultEffort !== undefined && defaultEffort !== null && efforts !== undefined && !efforts.includes(defaultEffort)) {
        warnings.push(`${modelId}：默认档 ${defaultEffort} 不在档位列表内，置 null`);
        return { ...reasoning, defaultEffort: null };
    }
    return reasoning;
};

const completeApis = (apiNames: readonly ModelApiName[]): ModelCatalogApis | undefined => {
    if (apiNames.length === 0) return undefined;
    const apis: MutableApis = {};
    for (const name of apiNames) {
        apis[name] = {};
    }
    return apis;
};

const completePatch = (evidence: CapabilityEvidence, modelId: string, warnings: string[]): CapabilityPatch => {
    // api.json type only gets a say about kind when the output modalities back it
    const { kind: assertedKind, ...patch } = evidence.patch;
    const input = patch.modalities?.input;
    const output = patch.modalities?.output;
    const imageOutput = patch.imageOutput ?? (output === undefined ? undefined : output.includes('image'));
    const vision = patch.vision ?? (input === undefined ? undefined : input.includes('image'));
    const modalityKind = output === undefined ? undefined : output.includes('image') ? 'image' : 'chat';
    if (assertedKind !== undefined && modalityKind === undefined) {
        warnings.push(`${modelId}：api.json type（${assertedKind}）没有输出模态证据，不用于 kind`);
    }
    if (assertedKind !== undefined && modalityKind !== undefined && assertedKind !== modalityKind) {
        warnings.push(`${modelId}：api.json type（${assertedKind}）与输出模态（${modalityKind}）不一致，按输出模态处理`);
    }
    const kind = modalityKind;
    const reasoning = clampReasoningPatch(patch.reasoning, modelId, warnings);
    const apis = completeApis(evidence.apiNames);
    return {
        ...patch,
        ...(kind === undefined ? {} : { kind }),
        ...(vision === undefined ? {} : { vision }),
        ...(imageOutput === undefined ? {} : { imageOutput }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(apis === undefined ? {} : { apis }),
    };
};

const candidateOf = (
    ref: CatalogModelRef,
    documents: CatalogDocuments,
    apiRoot: TomlNode | null,
    checkedOn: string,
    warnings: string[]
): CapabilityCandidate | null => {
    const apiModel = apiRoot === null ? null : apiJsonModelOf(apiRoot, ref);
    const apiEvidence = apiModel === null ? null : apiJsonEvidenceOf(apiModel, ref.model, warnings);
    const labBody = documents.labTomlByModel.get(ref.model);
    const labEvidence = labBody === undefined ? null : labTomlEvidenceOf(labBody, ref.model, warnings);
    const providerBody = documents.tomlByModel.get(ref.model);
    const providerEvidence =
        providerBody === undefined ? null : providerTomlEvidenceOf(providerBody, ref.model, warnings);
    const evidence = mergeEvidence(
        mergeEvidence(apiEvidence ?? NO_EVIDENCE, labEvidence ?? NO_EVIDENCE),
        providerEvidence ?? NO_EVIDENCE
    );
    const patch = completePatch(evidence, ref.model, warnings);
    if (isEmptyPatch(patch)) return null;
    return {
        model: ref.model,
        patch,
        checkedOn,
        origins: evidence.origins,
    };
};

/** Turn the downloaded catalogs into per-model partial capability candidates */
export const compileCapabilityObservations = (
    documents: CatalogDocuments,
    options: CapabilityCompileOptions
): CapabilityCompileResult => {
    const warnings: string[] = [];
    const refs = options.refs ?? catalogModelRefs();
    const apiRoot = options.apiJsonRoot !== undefined ? options.apiJsonRoot : apiJsonRootOf(options.apiJson ?? null, warnings);
    const checkedOn = isoDay(options.now);
    const candidates: CapabilityCandidate[] = [];
    for (const ref of refs) {
        try {
            const candidate = candidateOf(ref, documents, apiRoot, checkedOn, warnings);
            if (candidate !== null) candidates.push(candidate);
        } catch (error) {
            // Defensive: one broken document must never cost the run
            warnings.push(`${ref.model}：能力解析异常（${messageOf(error)}）`);
        }
    }
    return { candidates, warnings };
};

const apiJsonRootOf = (body: string | null, warnings: string[]): TomlNode | null => {
    if (body === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        warnings.push(`models.dev api.json 解析失败（${messageOf(error)}）`);
        return null;
    }
    if (!isJsonObject(parsed)) {
        warnings.push('models.dev api.json 不是一个对象，已忽略');
        return null;
    }
    return parsed;
};

// ---------------------------------------------------------------------------
// Differ: overlay the candidate onto the row and draft what changes
// ---------------------------------------------------------------------------

/** Values render as the approval message shows them */
const booleanText = (value: boolean | undefined): string =>
    value === undefined ? '未知' : value ? '是' : '否';

const enabledText = (value: boolean | null | undefined): string =>
    value === undefined || value === null ? '未知' : value ? '开' : '关';

const tokensText = (value: number | null | undefined): string =>
    value === undefined || value === null ? '未知' : String(value);

const listText = (values: readonly string[] | undefined): string =>
    values === undefined || values.length === 0 ? '未知' : values.join('/');

const modalityText = (values: readonly string[] | undefined): string =>
    values === undefined ? '未知' : values.length === 0 ? '无' : values.join('/');

const defaultEffortText = (value: ModelEffort | null | undefined): string =>
    value === undefined || value === null ? '未知' : value;

const hasNonReasoningAssertion = (patch: CapabilityPatch): boolean =>
    patch.kind !== undefined ||
    patch.vision !== undefined ||
    patch.imageOutput !== undefined ||
    patch.tools !== undefined ||
    patch.contextTokens !== undefined ||
    patch.outputTokens !== undefined ||
    patch.modalities !== undefined ||
    patch.apis !== undefined;

const overlayReasoning = (
    patch: CapabilityReasoningPatch | undefined,
    current: ModelCatalogReasoning | undefined,
    checkedOn: string,
    blockedReasoningFields?: ReadonlySet<string>
): ModelCatalogReasoning | undefined => {
    if (patch === undefined) return current;
    const supported = blockedReasoningFields?.has('reasoning.supported')
        ? (current?.supported ?? true)
        : (patch.supported ?? current?.supported ?? true);
    const toggle = blockedReasoningFields?.has('reasoning.toggle')
        ? current?.toggle
        : prefer(patch.toggle, current?.toggle);
    const assertedEfforts = blockedReasoningFields?.has('reasoning.efforts')
        ? current?.efforts
        : prefer(patch.efforts, current?.efforts);
    const efforts = supported ? assertedEfforts : [];
    const keptDefaultEffort = supported
        ? !blockedReasoningFields?.has('reasoning.defaultEffort') && patch.defaultEffort !== undefined
            ? patch.defaultEffort
            : (current?.defaultEffort ?? null)
        : null;
    // A default that the (possibly new) list does not contain is unknown, not sent
    const defaultEffort =
        keptDefaultEffort !== null && efforts !== undefined && !efforts.includes(keptDefaultEffort)
            ? null
            : keptDefaultEffort;
    const defaultEnabled = supported
        ? !blockedReasoningFields?.has('reasoning.defaultEnabled') && patch.defaultEnabled !== undefined
            ? patch.defaultEnabled
            : (current?.defaultEnabled ?? null)
        : null;
    const allReasoningProtected = blockedReasoningFields !== undefined && blockedReasoningFields.size > 0;
    const reasoningSource: ModelCapabilitySource =
        allReasoningProtected && current?.source !== undefined ? current.source : CAPABILITY_UPSTREAM_SOURCE;
    return {
        supported,
        ...(toggle === undefined ? {} : { toggle }),
        ...(efforts === undefined ? {} : { efforts }),
        defaultEffort,
        defaultEnabled,
        source: reasoningSource,
        checkedOn: reasoningSource === CAPABILITY_UPSTREAM_SOURCE ? checkedOn : (current?.checkedOn ?? checkedOn),
        confidence:
            reasoningSource === CAPABILITY_UPSTREAM_SOURCE
                ? CAPABILITY_PROPOSAL_CONFIDENCE
                : (current?.confidence ?? CAPABILITY_PROPOSAL_CONFIDENCE),
    };
};

const overlayModalities = (
    patch: ModelCatalogModalities | undefined,
    current: ModelCatalogModalities | undefined
): ModelCatalogModalities | undefined => {
    if (patch === undefined) return current;
    const input = prefer(patch.input, current?.input);
    const output = prefer(patch.output, current?.output);
    if (input === undefined && output === undefined) return undefined;
    return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
};

const overlayApis = (patch: ModelCatalogApis | undefined, current: ModelCatalogApis | undefined): ModelCatalogApis | undefined => {
    if (patch === undefined) return current;
    const apis: MutableApis = {};
    for (const name of MODEL_APIS) {
        const flags = mergeApiFlags(current?.[name], patch[name]);
        if (flags === undefined) continue;
        apis[name] = flags;
    }
    return Object.keys(apis).length === 0 ? undefined : apis;
};

const upstreamProvenanceEntry = (checkedOn: string): CapabilityFieldProvenance => ({
    source: CAPABILITY_UPSTREAM_SOURCE,
    checkedOn,
    confidence: CAPABILITY_PROPOSAL_CONFIDENCE,
});

const assertedPatchFieldsOf = (patch: CapabilityPatch): readonly string[] => {
    const fields: string[] = [];
    if (patch.kind !== undefined) fields.push('kind');
    if (patch.vision !== undefined) fields.push('vision');
    if (patch.imageOutput !== undefined) fields.push('imageOutput');
    if (patch.tools !== undefined) fields.push('tools');
    if (patch.contextTokens !== undefined) fields.push('contextTokens');
    if (patch.outputTokens !== undefined) fields.push('outputTokens');
    if (patch.modalities?.input !== undefined) fields.push('modalities.input');
    if (patch.modalities?.output !== undefined) fields.push('modalities.output');
    if (patch.apis !== undefined) fields.push('apis');
    if (patch.reasoning?.supported !== undefined) fields.push('reasoning.supported');
    if (patch.reasoning?.toggle !== undefined) fields.push('reasoning.toggle');
    if (patch.reasoning?.efforts !== undefined) fields.push('reasoning.efforts');
    if (patch.reasoning?.defaultEffort !== undefined) fields.push('reasoning.defaultEffort');
    if (patch.reasoning?.defaultEnabled !== undefined) fields.push('reasoning.defaultEnabled');
    return fields;
};

const overlayCapabilities = (
    patch: CapabilityPatch,
    current: ModelCatalogCapabilities,
    checkedOn: string,
    blockedReasoningFields?: ReadonlySet<string>
): ModelCatalogCapabilities => {
    const reasoning = overlayReasoning(patch.reasoning, current.reasoning, checkedOn, blockedReasoningFields);
    const modalities = overlayModalities(patch.modalities, current.modalities);
    const apis = overlayApis(patch.apis, current.apis);
    const efforts = reasoning?.efforts ?? current.reasoningEffort;
    const upstream = hasNonReasoningAssertion(patch);
    const provenanceMeta: Pick<ModelCatalogCapabilities, 'source' | 'checkedOn' | 'confidence'> = upstream
        ? {
              source: CAPABILITY_UPSTREAM_SOURCE,
              checkedOn,
              confidence: CAPABILITY_PROPOSAL_CONFIDENCE,
          }
        : {
              ...(current.source === undefined ? {} : { source: current.source }),
              ...(current.checkedOn === undefined ? {} : { checkedOn: current.checkedOn }),
              ...(current.confidence === undefined ? {} : { confidence: current.confidence }),
          };
    const nextFieldProvenance: Record<string, CapabilityFieldProvenance | undefined> = {
        ...(current.provenance ?? deriveFieldProvenance(current)),
    };
    const upstreamEntry = upstreamProvenanceEntry(checkedOn);
    for (const field of assertedPatchFieldsOf(patch)) {
        if (blockedReasoningFields?.has(field)) continue;
        nextFieldProvenance[field] = upstreamEntry;
    }
    return {
        schema: 1,
        kind: patch.kind ?? current.kind,
        vision: patch.vision ?? current.vision,
        imageOutput: patch.imageOutput ?? current.imageOutput,
        tools: patch.tools ?? current.tools,
        reasoningEffort: efforts,
        contextTokens: patch.contextTokens ?? current.contextTokens,
        outputTokens: patch.outputTokens ?? current.outputTokens,
        ...(modalities === undefined ? {} : { modalities }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(apis === undefined ? {} : { apis }),
        ...(current.toolsMixing === undefined ? {} : { toolsMixing: current.toolsMixing }),
        ...(current.nativeTools === undefined ? {} : { nativeTools: current.nativeTools }),
        ...provenanceMeta,
        provenance: nextFieldProvenance,
        ...(current.laneFingerprints === undefined ? {} : { laneFingerprints: current.laneFingerprints }),
    };
};

const API_FLAGS = ['reasoning', 'tools', 'structuredOutput'] as const;

/** Every semantic field that differs; provenance/legacy mirrors are not compared */
const changesOf = (
    next: ModelCatalogCapabilities,
    current: ModelCatalogCapabilities
): readonly CapabilityFieldChange[] => {
    const changes: CapabilityFieldChange[] = [];
    const compare = (field: string, oldValue: string, newValue: string): void => {
        if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
    };
    compare('kind', current.kind, next.kind);
    compare('vision', booleanText(current.vision), booleanText(next.vision));
    compare('imageOutput', booleanText(current.imageOutput), booleanText(next.imageOutput));
    compare('tools', booleanText(current.tools), booleanText(next.tools));
    compare('contextTokens', tokensText(current.contextTokens), tokensText(next.contextTokens));
    compare('outputTokens', tokensText(current.outputTokens), tokensText(next.outputTokens));
    compare('modalities.input', modalityText(current.modalities?.input), modalityText(next.modalities?.input));
    compare('modalities.output', modalityText(current.modalities?.output), modalityText(next.modalities?.output));
    compare('reasoning.supported', booleanText(current.reasoning?.supported), booleanText(next.reasoning?.supported));
    compare('reasoning.toggle', booleanText(current.reasoning?.toggle), booleanText(next.reasoning?.toggle));
    compare('reasoning.efforts', listText(current.reasoning?.efforts), listText(next.reasoning?.efforts));
    compare(
        'reasoning.defaultEffort',
        defaultEffortText(current.reasoning?.defaultEffort),
        defaultEffortText(next.reasoning?.defaultEffort)
    );
    compare(
        'reasoning.defaultEnabled',
        enabledText(current.reasoning?.defaultEnabled),
        enabledText(next.reasoning?.defaultEnabled)
    );
    for (const name of MODEL_APIS) {
        compare(
            `apis.${name}`,
            booleanText(current.apis === undefined ? undefined : current.apis[name] !== undefined),
            booleanText(next.apis === undefined ? undefined : next.apis[name] !== undefined)
        );
        for (const flag of API_FLAGS) {
            compare(
                `apis.${name}.${flag}`,
                booleanText(current.apis?.[name]?.[flag]),
                booleanText(next.apis?.[name]?.[flag])
            );
        }
    }
    compare('toolsMixing', current.toolsMixing ?? '未知', next.toolsMixing ?? '未知');
    return changes;
};

const noteOf = (changes: readonly CapabilityFieldChange[], checkedOn: string): string => {
    const fields = changes
        .slice(0, 4)
        .map((change) => change.field)
        .join('、');
    const more = changes.length > 4 ? ` 等 ${changes.length} 项` : '';
    return `能力变化：${fields}${more}（models.dev，${checkedOn}）`;
};

/**
 * Locally maintained capabilities are never proposed over (design §2.1 / §3.2):
 * manual edits, official docs, and active-lane probe/traffic measurements.
 * A probe/traffic entry whose lane fingerprint no longer matches the live
 * channel is unfrozen so upstream/re-probe resumes.
 */
const isLocalOverrideSource = (source: ModelCapabilitySource | undefined): boolean =>
    source === 'manual' || source === 'probe' || source === 'official' || source === 'traffic';

const isFieldBlockedFromUpstream = (
    current: ModelCatalogCapabilities,
    field: string,
    liveLane: string | undefined,
    staleWarnings: Set<string>,
    modelId: string
): { readonly blocked: boolean; readonly source?: ModelCapabilitySource } => {
    const prov = fieldProvenanceOf(current, field);
    if (prov === undefined || !isLocalOverrideSource(prov.source)) return { blocked: false };
    if (
        (prov.source === 'probe' || prov.source === 'traffic') &&
        liveLane !== undefined &&
        prov.lane !== undefined &&
        prov.lane !== liveLane
    ) {
        staleWarnings.add(
            `${modelId}：${field} 的 ${prov.source} 通道指纹已变更（${prov.lane} → ${liveLane}），已解除冻结并建议重新 probe`
        );
        return { blocked: false };
    }
    return { blocked: true, source: prov.source };
};

/** How a warning names the source that owns a locally maintained field */
const localSourceLabelOf = (source: ModelCapabilitySource | undefined): string => {
    if (source === 'official') return '官方文档';
    if (source === 'manual') return '机主手改';
    if (source === 'probe') return 'probe';
    if (source === 'traffic') return '线上流量';
    return '本地覆盖';
};

const filterReasoningPatchByField = (
    reasoning: CapabilityReasoningPatch | undefined,
    blockedFields: ReadonlySet<string>
): CapabilityReasoningPatch | undefined => {
    if (reasoning === undefined) return undefined;
    const filtered: CapabilityReasoningPatch = {
        ...(reasoning.supported === undefined || blockedFields.has('reasoning.supported')
            ? {}
            : { supported: reasoning.supported }),
        ...(reasoning.toggle === undefined || blockedFields.has('reasoning.toggle')
            ? {}
            : { toggle: reasoning.toggle }),
        ...(reasoning.efforts === undefined || blockedFields.has('reasoning.efforts')
            ? {}
            : { efforts: reasoning.efforts }),
        ...(reasoning.defaultEffort === undefined || blockedFields.has('reasoning.defaultEffort')
            ? {}
            : { defaultEffort: reasoning.defaultEffort }),
        ...(reasoning.defaultEnabled === undefined || blockedFields.has('reasoning.defaultEnabled')
            ? {}
            : { defaultEnabled: reasoning.defaultEnabled }),
    };
    return Object.keys(filtered).length === 0 ? undefined : filtered;
};

const filterPatchByProvenance = (
    patch: CapabilityPatch,
    blockedFields: ReadonlySet<string>
): { readonly filled: CapabilityPatch; readonly blockedReasoningFields: ReadonlySet<string> } => {
    const blockedReasoningFields = new Set(
        [...blockedFields].filter((field) => field.startsWith('reasoning.'))
    );
    const reasoning = filterReasoningPatchByField(patch.reasoning, blockedReasoningFields);
    const input =
        patch.modalities?.input !== undefined && !blockedFields.has('modalities.input')
            ? patch.modalities.input
            : undefined;
    const output =
        patch.modalities?.output !== undefined && !blockedFields.has('modalities.output')
            ? patch.modalities.output
            : undefined;
    const modalities =
        input === undefined && output === undefined
            ? undefined
            : { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
    const filled: CapabilityPatch = {
        ...(patch.kind === undefined || blockedFields.has('kind') ? {} : { kind: patch.kind }),
        ...(patch.vision === undefined || blockedFields.has('vision') ? {} : { vision: patch.vision }),
        ...(patch.imageOutput === undefined || blockedFields.has('imageOutput')
            ? {}
            : { imageOutput: patch.imageOutput }),
        ...(patch.tools === undefined || blockedFields.has('tools') ? {} : { tools: patch.tools }),
        ...(patch.contextTokens === undefined || blockedFields.has('contextTokens')
            ? {}
            : { contextTokens: patch.contextTokens }),
        ...(patch.outputTokens === undefined || blockedFields.has('outputTokens')
            ? {}
            : { outputTokens: patch.outputTokens }),
        ...(modalities === undefined ? {} : { modalities }),
        ...(patch.apis === undefined || blockedFields.has('apis') ? {} : { apis: patch.apis }),
        ...(reasoning === undefined ? {} : { reasoning }),
    };
    return { filled, blockedReasoningFields };
};

const fieldNameForChange = (field: string): string =>
    field.startsWith('apis.') ? 'apis' : field;

const draftOf = (
    candidate: CapabilityCandidate,
    entry: ModelCatalogEntry,
    checkedOn: string,
    warnings: string[],
    liveLane: string | undefined
): CapabilityProposalDraft | null => {
    const current = entry.capabilities;
    const unfilteredChanges = changesOf(overlayCapabilities(candidate.patch, current, checkedOn), current);
    const blockedFields = new Set<string>();
    const staleWarnings = new Set<string>();
    const blockedReasoningSources = new Set<ModelCapabilitySource>();
    const blockedOtherSources = new Set<ModelCapabilitySource>();
    for (const change of unfilteredChanges) {
        const lookupField = fieldNameForChange(change.field);
        const check = isFieldBlockedFromUpstream(current, lookupField, liveLane, staleWarnings, entry.id);
        if (!check.blocked) continue;
        blockedFields.add(lookupField);
        if (check.source === undefined) continue;
        if (lookupField.startsWith('reasoning.')) blockedReasoningSources.add(check.source);
        else blockedOtherSources.add(check.source);
    }
    for (const staleWarning of staleWarnings) warnings.push(staleWarning);
    for (const source of blockedReasoningSources) {
        warnings.push(
            `${entry.id}：思考档位由 ${localSourceLabelOf(source)} 维护，不提案（上游与本地覆盖不一致）`
        );
    }
    for (const source of blockedOtherSources) {
        warnings.push(
            `${entry.id}：能力字段由 ${localSourceLabelOf(source)} 维护，不提案（上游与本地覆盖不一致）`
        );
    }
    const { filled, blockedReasoningFields } = filterPatchByProvenance(candidate.patch, blockedFields);
    if (isEmptyPatch(filled)) return null;
    const payload = overlayCapabilities(filled, current, checkedOn, blockedReasoningFields);
    const changes = changesOf(payload, current);
    if (changes.length === 0) return null;
    return {
        model: entry.id,
        payload,
        baseline: current,
        changes,
        note: noteOf(changes, checkedOn),
        checkedOn,
    };
};

/**
 * Overlay the candidates onto the catalog rows and draft the changes: enabled
 * rows only, local overrides preserved, at most `MAX_CAPABILITY_PROPOSALS_PER_RUN`
 * drafts per run, zero drafts when nothing changed. Never throws.
 */
export const diffCapabilityCandidates = (
    candidates: readonly CapabilityCandidate[],
    currentEntries: readonly ModelCatalogEntry[],
    options: CapabilityDiffOptions & { readonly currentLaneFingerprints?: PlatformLaneFingerprints }
): CapabilityDiffResult => {
    const warnings: string[] = [];
    const maxProposals = options.maxProposals ?? MAX_CAPABILITY_PROPOSALS_PER_RUN;
    const justAdded = new Set(options.justAddedModels ?? []);
    const entries = new Map(currentEntries.map((entry) => [entry.id, entry]));
    const checkedOn = isoDay(options.now);
    const drafts: CapabilityProposalDraft[] = [];
    for (const candidate of candidates) {
        const entry = entries.get(candidate.model);
        // Not a catalog row (a price-table-only or seed-only id): nothing to approve
        if (entry === undefined) continue;
        // A retired row is never written back into the menu
        if (!entry.enabled) continue;
        // Auto-added rows wait one run so the owner sees their real data first
        if (justAdded.has(candidate.model)) continue;
        const liveLane = options.currentLaneFingerprints?.[platformOfModelId(entry.id)];
        const draft = draftOf(candidate, entry, checkedOn, warnings, liveLane);
        if (draft !== null) drafts.push(draft);
    }
    if (drafts.length > maxProposals) {
        warnings.push(`本次能力提案 ${drafts.length} 条，超过上限 ${maxProposals}，只保留前 ${maxProposals} 条`);
        return { drafts: drafts.slice(0, maxProposals), warnings };
    }
    return { drafts, warnings };
};

// ---------------------------------------------------------------------------
// Live-traffic contradiction scanner (design 2026-1114-0510 §3.3)
// ---------------------------------------------------------------------------

export interface TrafficContradictionOptions {
    readonly now: Date;
    readonly currentLaneFingerprints?: PlatformLaneFingerprints;
}

export interface TrafficContradictionResult {
    readonly drafts: readonly CapabilityProposalDraft[];
    readonly warnings: readonly string[];
}

const MODALITIES_SET: ReadonlySet<string> = new Set(MODEL_MODALITIES);
const isKnownModality = (value: string): value is ModelModality => MODALITIES_SET.has(value);

/**
 * Scan recent `reply_metrics.capabilityEvents` against the catalog and emit
 * `'traffic'` capability drafts when runtime rejections contradict catalog claims.
 */
export const compileTrafficContradictions = (
    eventRows: readonly ReplyMetricCapabilityEventRow[],
    currentEntries: readonly ModelCatalogEntry[],
    options: TrafficContradictionOptions
): TrafficContradictionResult => {
    const warnings: string[] = [];
    const drafts: CapabilityProposalDraft[] = [];
    const checkedOn = isoDay(options.now);
    const entries = new Map(currentEntries.map((entry) => [entry.id, entry]));
    const byModel = new Map<string, ReplyMetricCapabilityEventRow[]>();
    for (const row of eventRows) {
        const list = byModel.get(row.model);
        if (list === undefined) byModel.set(row.model, [row]);
        else list.push(row);
    }

    for (const [model, rows] of byModel) {
        const entry = entries.get(model);
        if (entry === undefined) continue;
        const current = entry.capabilities;
        const platform = platformOfModelId(model);
        const liveLane = options.currentLaneFingerprints?.[platform];

        const effortRejections = new Map<ModelEffort, number>();
        let budgetFallbackCount = 0;
        let toolsRejectedCount = 0;
        const mediaRejections = new Map<string, number>();
        const downgradedMaxTokens: number[] = [];
        let outputTruncatedCount = 0;

        for (const row of rows) {
            for (const event of row.capabilityEvents) {
                if (event.kind === 'effort_rejected') {
                    if (isModelEffort(event.effort)) {
                        effortRejections.set(event.effort, (effortRejections.get(event.effort) ?? 0) + 1);
                    }
                } else if (event.kind === 'thinking_budget_fallback') {
                    if (event.from !== undefined && event.from !== null && isModelEffort(event.from)) {
                        effortRejections.set(event.from, (effortRejections.get(event.from) ?? 0) + 1);
                    } else {
                        budgetFallbackCount += 1;
                    }
                } else if (event.kind === 'tools_rejected') {
                    toolsRejectedCount += 1;
                } else if (event.kind === 'media_rejected') {
                    const key = event.modality ?? 'non-image';
                    mediaRejections.set(key, (mediaRejections.get(key) ?? 0) + 1);
                } else if (event.kind === 'max_tokens_downgraded') {
                    downgradedMaxTokens.push(event.to);
                } else if (event.kind === 'output_truncated') {
                    outputTruncatedCount += 1;
                }
            }
        }

        const trafficEntry: CapabilityFieldProvenance = {
            source: 'traffic',
            checkedOn,
            confidence: 'high',
            ...(liveLane === undefined ? {} : { lane: liveLane }),
        };
        const nextProvenance: Record<string, CapabilityFieldProvenance | undefined> = {
            ...(current.provenance ?? deriveFieldProvenance(current)),
        };
        let next: ModelCatalogCapabilities = { ...current };
        const summaryParts: string[] = [];

        // 1. Effort rejections contradicting reasoning.efforts
        const currentEfforts = current.reasoning?.efforts ?? [];
        const contradictedEfforts = [...effortRejections.keys()].filter((effort) => currentEfforts.includes(effort));
        if (contradictedEfforts.length > 0) {
            const totalCount = contradictedEfforts.reduce(
                (sum, effort) => sum + (effortRejections.get(effort) ?? 0),
                0
            );
            warnings.push(
                `${model}：线上流量 ${totalCount} 次拒绝档位 ${contradictedEfforts.join('、')}，与目录冲突`
            );
            if (fieldProvenanceOf(current, 'reasoning.efforts')?.source !== 'manual') {
                const nextEfforts = currentEfforts.filter((effort) => !contradictedEfforts.includes(effort));
                const keptDefault = current.reasoning?.defaultEffort ?? null;
                const nextDefault =
                    keptDefault !== null && !nextEfforts.includes(keptDefault) ? null : keptDefault;
                const nextReasoning: ModelCatalogReasoning = {
                    ...(current.reasoning ?? { supported: true }),
                    efforts: nextEfforts,
                    defaultEffort: nextDefault,
                    source: 'traffic',
                    checkedOn,
                    confidence: 'high',
                };
                nextProvenance['reasoning.efforts'] = trafficEntry;
                next = {
                    ...next,
                    schema: 1,
                    reasoningEffort: nextEfforts,
                    reasoning: nextReasoning,
                };
                summaryParts.push(`${totalCount} 次拒绝档位 ${contradictedEfforts.join('/')}`);
            }
        }

        if (budgetFallbackCount > 0 && current.reasoning?.supported !== false) {
            warnings.push(
                `${model}：线上流量 ${budgetFallbackCount} 次触发 thinkingBudget 降级，请核对思考支持能力`
            );
        }

        // 2. Tools rejected (Gemini toolsMixing vs tools)
        if (toolsRejectedCount > 0) {
            if (platform === 'gemini' && current.toolsMixing !== 'denied' && current.tools !== false) {
                warnings.push(`${model}：线上流量 ${toolsRejectedCount} 次拒绝函数声明，与目录冲突（toolsMixing）`);
                if (fieldProvenanceOf(current, 'toolsMixing')?.source !== 'manual') {
                    nextProvenance['toolsMixing'] = trafficEntry;
                    next = { ...next, schema: 1, toolsMixing: 'denied' };
                    summaryParts.push(`${toolsRejectedCount} 次拒绝混合工具`);
                }
            } else if (current.tools) {
                warnings.push(`${model}：线上流量 ${toolsRejectedCount} 次拒绝工具调用，与目录冲突（tools）`);
                if (fieldProvenanceOf(current, 'tools')?.source !== 'manual') {
                    nextProvenance['tools'] = trafficEntry;
                    next = { ...next, schema: 1, tools: false };
                    summaryParts.push(`${toolsRejectedCount} 次拒绝工具调用`);
                }
            }
        }

        // 3. Media rejected (modalities.input)
        if (mediaRejections.size > 0) {
            const totalMediaCount = [...mediaRejections.values()].reduce((sum, count) => sum + count, 0);
            const currentInput = current.modalities?.input ?? [];
            const nonImageModalities = currentInput.filter((item) => item !== 'text' && item !== 'image');
            const toRemove = new Set<ModelModality>();
            for (const key of mediaRejections.keys()) {
                if (isKnownModality(key) && currentInput.includes(key)) {
                    toRemove.add(key);
                } else if (key === 'non-image' && nonImageModalities.length === 1 && nonImageModalities[0] !== undefined) {
                    toRemove.add(nonImageModalities[0]);
                }
            }
            warnings.push(
                `${model}：线上流量 ${totalMediaCount} 次拒绝媒体输入（${[...mediaRejections.keys()].join('、')}）`
            );
            if (toRemove.size > 0 && fieldProvenanceOf(current, 'modalities.input')?.source !== 'manual') {
                const nextInput = currentInput.filter((item) => !toRemove.has(item));
                const nextModalities: ModelCatalogModalities = {
                    ...current.modalities,
                    input: nextInput,
                };
                nextProvenance['modalities.input'] = trafficEntry;
                if (toRemove.has('image') && current.vision) {
                    nextProvenance['vision'] = trafficEntry;
                    next = { ...next, vision: false };
                }
                next = { ...next, schema: 1, modalities: nextModalities };
                summaryParts.push(`${totalMediaCount} 次拒绝媒体 ${[...toRemove].join('/')}`);
            }
        }

        // 4. max_tokens downgraded (outputTokens ceiling)
        if (downgradedMaxTokens.length > 0) {
            const minTo = Math.min(...downgradedMaxTokens);
            if (current.outputTokens === null || current.outputTokens > minTo) {
                warnings.push(
                    `${model}：线上流量 ${downgradedMaxTokens.length} 次触发 max_tokens 降级至 ${minTo}，与目录上限冲突`
                );
                if (fieldProvenanceOf(current, 'outputTokens')?.source !== 'manual') {
                    nextProvenance['outputTokens'] = trafficEntry;
                    next = { ...next, schema: 1, outputTokens: minTo };
                    summaryParts.push(`${downgradedMaxTokens.length} 次 max_tokens 降级至 ${minTo}`);
                }
            }
        }

        if (outputTruncatedCount > 0) {
            warnings.push(`${model}：线上流量 ${outputTruncatedCount} 次因输出达上限被截断`);
        }

        if (summaryParts.length === 0) continue;
        const payload: ModelCatalogCapabilities = {
            ...next,
            provenance: nextProvenance,
            ...(liveLane === undefined
                ? {}
                : { laneFingerprints: { ...current.laneFingerprints, [platform]: liveLane } }),
        };
        const changes = changesOf(payload, current);
        if (changes.length === 0) continue;
        drafts.push({
            model,
            payload,
            baseline: current,
            changes,
            note: `线上流量告警：${summaryParts.join('；')}（traffic，${checkedOn}）`,
            checkedOn,
        });
    }

    return { drafts, warnings };
};

/** Merge upstream and live-traffic capability drafts for the same model; traffic takes precedence on conflicts */
export const mergeCapabilityDrafts = (
    upstreamDrafts: readonly CapabilityProposalDraft[],
    trafficDrafts: readonly CapabilityProposalDraft[]
): readonly CapabilityProposalDraft[] => {
    if (trafficDrafts.length === 0) return upstreamDrafts;
    if (upstreamDrafts.length === 0) return trafficDrafts;
    const byModel = new Map<string, CapabilityProposalDraft>();
    for (const draft of upstreamDrafts) byModel.set(draft.model, draft);
    for (const traffic of trafficDrafts) {
        const upstream = byModel.get(traffic.model);
        if (upstream === undefined) {
            byModel.set(traffic.model, traffic);
            continue;
        }
        const mergedProvenance: CapabilityProvenanceMap = {
            ...upstream.payload.provenance,
            ...traffic.payload.provenance,
        };
        const mergedReasoning =
            traffic.payload.reasoning?.source === 'traffic'
                ? traffic.payload.reasoning
                : upstream.payload.reasoning;
        const mergedModalities =
            traffic.payload.provenance?.['modalities.input']?.source === 'traffic'
                ? {
                      ...upstream.payload.modalities,
                      ...(traffic.payload.modalities?.input === undefined
                          ? {}
                          : { input: traffic.payload.modalities.input }),
                  }
                : upstream.payload.modalities;
        const payload: ModelCatalogCapabilities = {
            ...upstream.payload,
            ...(traffic.payload.provenance?.['tools']?.source === 'traffic' ? { tools: traffic.payload.tools } : {}),
            ...(traffic.payload.provenance?.['toolsMixing']?.source === 'traffic'
                ? { toolsMixing: traffic.payload.toolsMixing }
                : {}),
            ...(traffic.payload.provenance?.['vision']?.source === 'traffic' ? { vision: traffic.payload.vision } : {}),
            ...(traffic.payload.provenance?.['outputTokens']?.source === 'traffic'
                ? { outputTokens: traffic.payload.outputTokens }
                : {}),
            ...(mergedModalities === undefined ? {} : { modalities: mergedModalities }),
            ...(mergedReasoning === undefined ? {} : { reasoning: mergedReasoning }),
            reasoningEffort: mergedReasoning?.efforts ?? upstream.payload.reasoningEffort,
            provenance: mergedProvenance,
            ...(traffic.payload.laneFingerprints === undefined
                ? upstream.payload.laneFingerprints === undefined
                    ? {}
                    : { laneFingerprints: upstream.payload.laneFingerprints }
                : {
                      laneFingerprints: {
                          ...upstream.payload.laneFingerprints,
                          ...traffic.payload.laneFingerprints,
                      },
                  }),
        };
        const baseline = upstream.baseline ?? traffic.baseline;
        const changes = baseline === null ? [...upstream.changes, ...traffic.changes] : changesOf(payload, baseline);
        byModel.set(traffic.model, {
            model: traffic.model,
            payload,
            baseline,
            changes,
            note: `${traffic.note}；${upstream.note}`,
            checkedOn: traffic.checkedOn,
        });
    }
    return [...byModel.values()];
};
