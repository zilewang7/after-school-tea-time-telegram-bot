/**
 * Model traits: the single data → code entry point for "what can this model do"
 * (design 2026-1114-0510 §5).
 *
 * Resolution order: a `model_catalog` row with schema-1 capabilities, then the
 * code seed (`model-capability-seed.ts`), then per-platform pure code defaults
 * (`platforms/<p>/<p>-code-traits.ts`).
 *
 * S3–S6 cutover: all model capability traits prefer catalog/seed data with
 * per-platform pure code fallbacks. S5/S6 (`imageOutput`, `imageInput` /
 * `vision`, `mediaInput` / `modalities.input`, and `clientTools` / `tools`)
 * require verified field-level provenance (`fieldProvenanceOf` present and
 * `confidence !== 'low'`) before cutting over from `*-code-traits.ts`.
 */
import { match } from 'ts-pattern';
import {
    fieldProvenanceOf,
    type ModelCatalogCapabilities,
} from '../config/model-capabilities.js';
import { capabilitySeedIds, capabilitySeedOf } from '../config/model-capability-seed.js';
import {
    findModelCatalogEntry,
    listAllModelCatalog,
    modelCatalogVersion,
    type ModelCatalogEntry,
} from '../config/model-catalog.js';
import { getToolConfig } from '../config/tool-config.js';
import { platformTypeOf } from './platform-routing.js';
import { anthropicCodeTraitsOf } from './platforms/anthropic/anthropic-code-traits.js';
import { deepseekCodeTraitsOf } from './platforms/deepseek/deepseek-code-traits.js';
import { geminiCodeTraitsOf } from './platforms/gemini/gemini-code-traits.js';
import { grokCodeTraitsOf } from './platforms/grok/grok-code-traits.js';
import { mimoCodeTraitsOf } from './platforms/mimo/mimo-code-traits.js';
import { openaiCodeTraitsOf } from './platforms/openai/openai-code-traits.js';
import type {
    ModelCapabilities,
    ModelTraitsOrigin,
    PlatformType,
    RuntimeTraits,
    Trait,
    TraitOrigin,
} from './types.js';

export type { ModelTraitsOrigin, RuntimeTraits, Trait, TraitOrigin };

export interface ModelTraits {
    readonly model: string;
    readonly origin: ModelTraitsOrigin;
    /** The platform the id routes to (prefix routing stays code) */
    readonly platform: PlatformType;
    /** schema-1 capabilities; null = no data, the code heuristics apply */
    readonly capabilities: ModelCatalogCapabilities | null;
}

interface PlatformCodeDefaults {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly geminiToolsMixing: boolean;
    readonly imageSearchGrounding: boolean;
    readonly xhighThinking: boolean;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean | undefined;
    readonly supportsVideoToolResult: boolean;
}

const codeDefaultsOf = (id: string, platform: PlatformType): PlatformCodeDefaults =>
    match(platform)
        .returnType<PlatformCodeDefaults>()
        .with('gemini', () => {
            const traits = geminiCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: traits.geminiToolsMixing,
                imageSearchGrounding: traits.imageSearchGrounding,
                xhighThinking: traits.xhighThinking,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: traits.supportsThinking,
                supportsVideoToolResult: traits.supportsVideoToolResult,
            };
        })
        .with('openai', () => {
            const traits = openaiCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: traits.clientTools,
                imageSearchGrounding: false,
                xhighThinking: false,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: traits.supportsThinking,
                supportsVideoToolResult: false,
            };
        })
        .with('anthropic', () => {
            const traits = anthropicCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: !traits.imageOutput,
                imageSearchGrounding: false,
                xhighThinking: false,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: traits.supportsThinking,
                supportsVideoToolResult: false,
            };
        })
        .with('deepseek', () => {
            const traits = deepseekCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: !traits.imageOutput,
                imageSearchGrounding: false,
                xhighThinking: false,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: undefined,
                supportsVideoToolResult: false,
            };
        })
        .with('grok', () => {
            const traits = grokCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: !traits.imageOutput,
                imageSearchGrounding: false,
                xhighThinking: false,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: undefined,
                supportsVideoToolResult: false,
            };
        })
        .with('mimo', () => {
            const traits = mimoCodeTraitsOf(id);
            return {
                imageOutput: traits.imageOutput,
                imageInput: traits.imageInput,
                mediaInput: traits.mediaInput,
                clientTools: traits.clientTools,
                geminiToolsMixing: !traits.imageOutput,
                imageSearchGrounding: false,
                xhighThinking: false,
                requiresMessageMerge: traits.requiresMessageMerge,
                supportsThinking: traits.supportsThinking,
                supportsVideoToolResult: false,
            };
        })
        .exhaustive();

/** Only Gemini and MiMo encode inline audio/video in their request protocols */
const protocolSupportsMedia = (platform: PlatformType): boolean =>
    platform === 'gemini' || platform === 'mimo';

/** Build a trait whose active runtime value still follows code (S6) */
const codeBackedTrait = <T>(codeValue: T, dataValue: T | null): Trait<T> => ({
    value: codeValue,
    origin: 'code',
    codeValue,
    dataValue,
    differs: dataValue !== null && dataValue !== codeValue,
});

/** Build a trait whose active runtime value prefers catalog/seed data with code fallback */
const dataBackedTrait = <T>(codeValue: T, dataValue: T | null): Trait<T> => ({
    value: dataValue ?? codeValue,
    origin: dataValue !== null ? 'data' : 'code',
    codeValue,
    dataValue,
    differs: dataValue !== null && dataValue !== codeValue,
});

/** S6 gate: cut over only when field provenance is present and not low-confidence */
const hasVerifiedFieldProvenance = (
    capabilities: ModelCatalogCapabilities | null,
    field: string
): boolean => {
    if (capabilities === null) return false;
    const provenance = fieldProvenanceOf(capabilities, field);
    if (provenance === undefined) return false;
    return provenance.confidence !== 'low';
};

const provenanceGatedTrait = <T>(
    codeValue: T,
    dataValue: T | null,
    verified: boolean
): Trait<T> => (verified ? dataBackedTrait(codeValue, dataValue) : codeBackedTrait(codeValue, dataValue));

const dataImageOutputOf = (capabilities: ModelCatalogCapabilities | null): boolean | null => {
    if (capabilities === null) return null;
    return capabilities.imageOutput || (capabilities.modalities?.output?.includes('image') ?? false);
};

const dataMediaInputOf = (
    capabilities: ModelCatalogCapabilities | null,
    platform: PlatformType
): boolean | null => {
    const input = capabilities?.modalities?.input;
    if (input === undefined) return null;
    if (!protocolSupportsMedia(platform)) return false;
    return input.includes('audio') || input.includes('video');
};

const dataGeminiToolsMixingOf = (
    capabilities: ModelCatalogCapabilities | null,
    platform: PlatformType
): boolean | null => {
    if (platform !== 'gemini' || capabilities === null) return null;
    const mixing = capabilities.toolsMixing;
    if (mixing === undefined || mixing === 'unknown') return null;
    return mixing === 'allowed';
};

const dataImageSearchGroundingOf = (
    capabilities: ModelCatalogCapabilities | null,
    platform: PlatformType
): boolean | null => {
    if (platform !== 'gemini' || capabilities === null) return null;
    const flag = capabilities.nativeTools?.imageSearchGrounding;
    return flag === undefined ? null : flag;
};

const dataXhighThinkingOf = (capabilities: ModelCatalogCapabilities | null): boolean | null => {
    const reasoning = capabilities?.reasoning;
    if (reasoning === undefined) return null;
    return (reasoning.efforts ?? []).includes('xhigh');
};

const resolveGeminiToolsMixingTrait = (
    codeValue: boolean,
    capabilities: ModelCatalogCapabilities | null,
    platform: PlatformType,
    imageOutputValue: boolean
): Trait<boolean> => {
    const dataValue = dataGeminiToolsMixingOf(capabilities, platform);
    // Keep the image-model-gets-no-tools safety guard even if a catalog row asserts toolsMixing
    if (imageOutputValue) {
        return {
            value: false,
            origin: dataValue !== null ? 'data' : 'code',
            codeValue,
            dataValue,
            differs: dataValue !== null && dataValue !== codeValue,
        };
    }
    return dataBackedTrait(codeValue, dataValue);
};

const resolveClientToolsTrait = (
    platform: PlatformType,
    codeValue: boolean,
    capabilities: ModelCatalogCapabilities | null,
    imageOutputValue: boolean,
    geminiToolsMixingValue: boolean,
    toolsVerified: boolean
): Trait<boolean> => {
    if (imageOutputValue) {
        // Never offer client tools to an image-output model regardless of catalog/provenance
        const dataValue = capabilities === null ? null : false;
        return dataBackedTrait(codeValue, dataValue);
    }
    if (platform === 'gemini') {
        const fallbackCode = codeValue && geminiToolsMixingValue;
        const dataValue =
            capabilities === null ? null : capabilities.tools && geminiToolsMixingValue;
        return provenanceGatedTrait(fallbackCode, dataValue, toolsVerified);
    }
    const dataValue = capabilities === null ? null : capabilities.tools;
    return provenanceGatedTrait(codeValue, dataValue, toolsVerified);
};

/** Resolve catalog/seed metadata for one model id */
export const resolveModelTraits = (model: string): ModelTraits => {
    const id = model.toLowerCase();
    const platform = platformTypeOf(id);
    const entry = findModelCatalogEntry(id);
    if (entry !== null && entry.capabilities.schema === 1) {
        return { model: id, origin: 'catalog', platform, capabilities: entry.capabilities };
    }
    const seed = capabilitySeedOf(id);
    if (seed !== null) return { model: id, origin: 'seed', platform, capabilities: seed };
    return { model: id, origin: 'code', platform, capabilities: null };
};

/** Resolve the full runtime traits snapshot for one model (once per reply attempt) */
export const resolveRuntimeTraits = (model: string): RuntimeTraits => {
    const id = model.toLowerCase();
    const platform = platformTypeOf(id);
    const entry = findModelCatalogEntry(id);
    const inCatalog = entry !== null;
    let origin: ModelTraitsOrigin = 'code';
    let capabilities: ModelCatalogCapabilities | null = null;
    if (entry !== null && entry.capabilities.schema === 1) {
        origin = 'catalog';
        capabilities = entry.capabilities;
    } else {
        const seed = capabilitySeedOf(id);
        if (seed !== null) {
            origin = 'seed';
            capabilities = seed;
        }
    }
    const code = codeDefaultsOf(id, platform);
    const reasoningData = capabilities?.reasoning ?? null;
    const outputTokensData = capabilities?.outputTokens ?? null;
    const imageOutput = provenanceGatedTrait(
        code.imageOutput,
        dataImageOutputOf(capabilities),
        hasVerifiedFieldProvenance(capabilities, 'imageOutput') ||
            hasVerifiedFieldProvenance(capabilities, 'modalities.output')
    );
    const geminiToolsMixing = resolveGeminiToolsMixingTrait(
        code.geminiToolsMixing,
        capabilities,
        platform,
        imageOutput.value
    );
    const clientTools = resolveClientToolsTrait(
        platform,
        code.clientTools,
        capabilities,
        imageOutput.value,
        geminiToolsMixing.value,
        hasVerifiedFieldProvenance(capabilities, 'tools')
    );
    const supportsThinking =
        platform === 'openai' && reasoningData !== null
            ? reasoningData.supported
            : code.supportsThinking;

    return {
        model: id,
        platform,
        origin,
        inCatalog,
        catalogVersion: modelCatalogVersion(),
        capabilities,
        imageOutput,
        imageInput: provenanceGatedTrait(
            code.imageInput,
            capabilities?.vision ?? null,
            hasVerifiedFieldProvenance(capabilities, 'vision')
        ),
        mediaInput: provenanceGatedTrait(
            code.mediaInput,
            dataMediaInputOf(capabilities, platform),
            hasVerifiedFieldProvenance(capabilities, 'modalities.input')
        ),
        clientTools,
        geminiToolsMixing,
        imageSearchGrounding: dataBackedTrait(
            code.imageSearchGrounding,
            dataImageSearchGroundingOf(capabilities, platform)
        ),
        xhighThinking: dataBackedTrait(code.xhighThinking, dataXhighThinkingOf(capabilities)),
        requiresMessageMerge: code.requiresMessageMerge,
        supportsThinking,
        supportsVideoToolResult: code.supportsVideoToolResult,
        reasoning: {
            value: reasoningData,
            origin: reasoningData !== null ? 'data' : 'code',
            codeValue: null,
            dataValue: reasoningData,
            differs: false,
        },
        outputTokens: {
            value: outputTokensData,
            origin: outputTokensData !== null ? 'data' : 'code',
            codeValue: null,
            dataValue: outputTokensData,
            differs: false,
        },
    };
};

/** Build legacy ModelCapabilities from resolved RuntimeTraits (applies env switches) */
export const capabilitiesOf = (traits: RuntimeTraits): ModelCapabilities => ({
    supportsImageInput: traits.imageInput.value,
    supportsImageOutput: traits.imageOutput.value,
    supportsSystemPrompt: true,
    requiresMessageMerge: traits.requiresMessageMerge,
    ...(traits.supportsThinking === undefined ? {} : { supportsThinking: traits.supportsThinking }),
    supportsMediaInput: traits.mediaInput.value,
    ...(traits.supportsVideoToolResult ? { supportsVideoToolResult: true } : {}),
    supportsClientTools:
        traits.platform === 'gemini'
            ? traits.clientTools.value && getToolConfig().geminiClientTools
            : traits.clientTools.value,
});

/** Image-output predicate backed by provenance-gated `traits.imageOutput` */
export const isImageOutputModelFromTraits = (traits: RuntimeTraits): boolean => traits.imageOutput.value;

/** Structured one-line log per reply attempt showing code fallbacks and diffs */
export const logReplyTraits = (traits: RuntimeTraits): void => {
    const traitEntries: ReadonlyArray<readonly [string, Trait<unknown>]> = [
        ['imageOutput', traits.imageOutput],
        ['imageInput', traits.imageInput],
        ['mediaInput', traits.mediaInput],
        ['clientTools', traits.clientTools],
        ...(traits.platform === 'gemini'
            ? ([
                  ['geminiToolsMixing', traits.geminiToolsMixing],
                  ['imageSearchGrounding', traits.imageSearchGrounding],
              ] as const)
            : []),
        ['reasoning', traits.reasoning],
        ...(traits.platform === 'anthropic' ? ([['outputTokens', traits.outputTokens]] as const) : []),
    ];
    const codeFallbacks = traitEntries
        .filter(([, trait]) => trait.origin === 'code')
        .map(([name]) => name);
    const diffs = traitEntries
        .filter(([, trait]) => trait.differs)
        .map(([name, trait]) => `${name}:${String(trait.dataValue)}!=${String(trait.codeValue)}`);
    const fallbackText = codeFallbacks.length > 0 ? codeFallbacks.join(',') : 'none';
    const diffText = diffs.length > 0 ? ` diffs=[${diffs.join(',')}]` : '';
    console.log(
        `[traits] model=${traits.model} platform=${traits.platform} origin=${traits.origin} ` +
            `catalog=${traits.catalogVersion} codeFallback=[${fallbackText}]${diffText}`
    );
};

export type ReconciledTraitField =
    | 'imageOutput'
    | 'imageInput'
    | 'mediaInput'
    | 'clientTools'
    | 'geminiToolsMixing'
    | 'imageSearchGrounding'
    | 'xhighThinking'
    | 'outputTokens';

export interface ReconciledTraitEntry<T = boolean | number | null> {
    readonly field: ReconciledTraitField;
    readonly data: T | null;
    readonly code: T | null;
    readonly runtime: T;
    readonly origin: TraitOrigin;
    readonly differs: boolean;
}

export interface ModelTraitReconciliationRow {
    readonly model: string;
    readonly platform: PlatformType;
    readonly origin: ModelTraitsOrigin;
    readonly inCatalog: boolean;
    readonly enabled: boolean;
    readonly entries: readonly ReconciledTraitEntry[];
    readonly diffCount: number;
}

export interface CatalogTraitsReconciliation {
    readonly catalogVersion: string;
    readonly rows: readonly ModelTraitReconciliationRow[];
    readonly totalDiffs: number;
}

const booleanEntry = (
    field: ReconciledTraitField,
    trait: Trait<boolean>,
    applicable = true
): ReconciledTraitEntry<boolean> => ({
    field,
    data: trait.dataValue,
    code: applicable ? trait.codeValue : null,
    runtime: trait.value,
    origin: trait.origin,
    differs: applicable && trait.differs,
});

const reconcileOneModel = (model: string, enabled: boolean): ModelTraitReconciliationRow => {
    const traits = resolveRuntimeTraits(model);
    const isGemini = traits.platform === 'gemini';
    const entries: readonly ReconciledTraitEntry[] = [
        booleanEntry('imageOutput', traits.imageOutput),
        booleanEntry('imageInput', traits.imageInput),
        booleanEntry('mediaInput', traits.mediaInput),
        booleanEntry('clientTools', traits.clientTools),
        booleanEntry('geminiToolsMixing', traits.geminiToolsMixing, isGemini),
        booleanEntry('imageSearchGrounding', traits.imageSearchGrounding, isGemini),
        booleanEntry('xhighThinking', traits.xhighThinking),
        {
            field: 'outputTokens',
            data: traits.outputTokens.dataValue,
            code: null,
            runtime: traits.outputTokens.value,
            origin: traits.outputTokens.origin,
            differs: false,
        },
    ];
    return {
        model: traits.model,
        platform: traits.platform,
        origin: traits.origin,
        inCatalog: traits.inCatalog,
        enabled,
        entries,
        diffCount: entries.filter((entry) => entry.differs).length,
    };
};

/**
 * Compute the deterministic code-vs-data reconciliation table ("对账表") across
 * all catalog entries and any remaining seed-only models (design §5.6).
 */
export const reconcileCatalogTraits = (
    catalogEntries: readonly ModelCatalogEntry[] = listAllModelCatalog()
): CatalogTraitsReconciliation => {
    const seen = new Set<string>();
    const rows: ModelTraitReconciliationRow[] = [];
    for (const entry of catalogEntries) {
        const id = entry.id.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(reconcileOneModel(id, entry.enabled));
    }
    for (const seedId of capabilitySeedIds()) {
        const id = seedId.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(reconcileOneModel(id, false));
    }
    const totalDiffs = rows.reduce((sum, row) => sum + row.diffCount, 0);
    return { catalogVersion: modelCatalogVersion(), rows, totalDiffs };
};
