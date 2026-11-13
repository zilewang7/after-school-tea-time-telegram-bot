/**
 * Model traits: the single data → code entry point for "what can this model do"
 * (thinking-effort design 2026-1113-1742 §3.1).
 *
 * Resolution order: a `model_catalog` row with schema-1 capabilities, then the
 * code seed (`model-capability-seed.ts`), then the code heuristics that ship in
 * this module. A trait with no data falls back to the heuristic; `capabilities`
 * is null only when neither the catalog nor the seed knows the model.
 *
 * PR2 keeps the runtime predicates on the code result: when
 * `MODEL_TRAITS_SHADOW=1` the data result is compared and each differing
 * `model|field` is logged once, so the switch to data can wait for a quiet week.
 * Flipping `runtimeTraitValuesOf` to the data result is the later PR.
 *
 * Lives in `src/ai`, not `src/config`: config may not import ai (check-deps),
 * and `model-kinds.ts` must not be imported here (that would close a cycle).
 */
import { match, P } from 'ts-pattern';
import { capabilitySeedOf } from '../config/model-capability-seed.js';
import { findModelCatalogEntry } from '../config/model-catalog.js';
import type { ModelCatalogCapabilities } from '../config/model-capabilities.js';
import { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../config/models.js';
import { platformTypeOf } from './platform-routing.js';
import type { PlatformType } from './types.js';

/** Where the resolved capabilities came from: a catalog row, the code seed, or none */
export type ModelTraitsOrigin = 'catalog' | 'seed' | 'code';

export interface ModelTraits {
    readonly model: string;
    readonly origin: ModelTraitsOrigin;
    /** The platform the id routes to (prefix routing stays code) */
    readonly platform: PlatformType;
    /** schema-1 capabilities; null = no data, the code heuristics apply */
    readonly capabilities: ModelCatalogCapabilities | null;
}

/** Resolve one model's traits from the in-memory catalog, the seed, or code */
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

/**
 * Models whose output is an image. Matched by explicit id first, because the
 * substring rule alone missed `gemini-nano-banana-2.1` — the Nano Banana ids
 * carry no `image` in them, and a missed image model is sent the chat persona,
 * urlContext and function tools, all of which it rejects with 400.
 */
const KNOWN_IMAGE_MODELS: ReadonlySet<string> = new Set([
    GEMINI_IMAGE_MODEL.toLowerCase(),
    OPENAI_IMAGE_MODEL.toLowerCase(),
    'gemini-3-pro-image',
]);

const codeIsImageOutputModel = (model: string): boolean =>
    match(model.toLowerCase())
        .when((id) => KNOWN_IMAGE_MODELS.has(id), () => true)
        .with(P.string.includes('image'), () => true)
        .with(P.string.includes('nano-banana'), () => true)
        .otherwise(() => false);

/**
 * Gemini chat models that only accept the built-in search tools: every 2.x
 * answers "Multiple tools are supported only when they are all search tools"
 * with 400. Newer ids (3.1-pro-preview, 3.8-flash, 4-argon, 4-carbon — all
 * verified on our own Vertex project) accept function declarations alongside
 * googleSearch, so the default is to offer client tools and only the known
 * refusals are denied by name; a model released tomorrow works without a code
 * change. An id that turns out to refuse mixed tools is caught at round 1 and
 * the platform retries the same request without the declarations.
 */
const GEMINI_SEARCH_ONLY_MODELS: ReadonlySet<string> = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
]);

const codeSupportsGeminiFunctionTools = (model: string): boolean => {
    const id = model.toLowerCase();
    return codeIsImageOutputModel(id) === false && GEMINI_SEARCH_ONLY_MODELS.has(id) === false;
};

/**
 * Image models that can ground a generation in real web images
 * (searchTypes.imageSearch). Verified 2026-10-23 on the image search endpoint:
 * nano-banana-2.1 returns imageSearchQueries + groundingChunks[].image only when
 * imageSearch and webSearch are both declared; gemini-3-pro-image rejects
 * imageSearch with 400 "image_search is not supported for this model".
 */
const GEMINI_IMAGE_SEARCH_GROUNDING_MODELS: ReadonlySet<string> = new Set([
    'gemini-nano-banana-2.1',
    'gemini-3.1-flash-image',
]);

const codeSupportsGeminiImageSearchGrounding = (model: string): boolean =>
    GEMINI_IMAGE_SEARCH_GROUNDING_MODELS.has(model.toLowerCase());

/**
 * Gemini 4 Hydrogen accepts the XHIGH thinking level on Vertex, one level above
 * HIGH — the documented top for Argon and Carbon, which answer 400 "Thinking
 * level is unsupported: THINKING_LEVEL_XHIGH". Other models keep HIGH; a model
 * that loses XHIGH later falls back to HIGH at request time (see GeminiPlatform).
 */
const codeSupportsXhighThinkingLevel = (model: string): boolean =>
    model.toLowerCase().startsWith('gemini-4-hydrogen');

/** The three predicates PR2 compares, computed from the code heuristics (today's behavior) */
export interface ModelTraitValues {
    readonly imageOutput: boolean;
    readonly xhighThinking: boolean;
    readonly geminiFunctionTools: boolean;
}

/** The code heuristics, exactly as they behave today */
export const codeTraitValuesOf = (model: string): ModelTraitValues => ({
    imageOutput: codeIsImageOutputModel(model),
    xhighThinking: codeSupportsXhighThinkingLevel(model),
    geminiFunctionTools: codeSupportsGeminiFunctionTools(model),
});

/** The same three predicates as the resolved data asserts them; null = not asserted */
export type TraitDataValues = {
    readonly [Key in keyof ModelTraitValues]: ModelTraitValues[Key] | null;
};

/** The data side of the shadow comparison */
export const dataTraitValuesOf = (model: string): TraitDataValues => {
    const { capabilities } = resolveModelTraits(model);
    if (capabilities === null) {
        return { imageOutput: null, xhighThinking: null, geminiFunctionTools: null };
    }
    const reasoning = capabilities.reasoning;
    const toolsMixing = capabilities.toolsMixing;
    return {
        imageOutput: capabilities.imageOutput,
        // No reasoning data = not known, not "no levels"
        xhighThinking: reasoning === undefined ? null : (reasoning.efforts ?? []).includes('xhigh'),
        geminiFunctionTools:
            toolsMixing === undefined || toolsMixing === 'unknown' ? null : toolsMixing === 'allowed',
    };
};

export type TraitField = keyof ModelTraitValues;

export interface TraitsShadowDiff {
    readonly model: string;
    readonly field: TraitField;
    readonly data: boolean;
    readonly code: boolean;
    /** When the diff was first seen; the shadow needs a quiet week to switch */
    readonly seenAt: Date;
}

const shadowDiffs = new Map<string, TraitsShadowDiff>();

/** `MODEL_TRAITS_SHADOW=1` compares data with code; read per call, default off */
export const traitsShadowEnabled = (): boolean => process.env.MODEL_TRAITS_SHADOW === '1';

/** The differences seen so far (tests and diagnostics) */
export const traitsShadowDiffs = (): readonly TraitsShadowDiff[] => [...shadowDiffs.values()];

/** Forget what the process has seen (tests and a manual reset) */
export const resetTraitsShadow = (): void => {
    shadowDiffs.clear();
};

/** Record one diff once per model|field and print it once */
const recordShadowDiff = (model: string, field: TraitField, data: boolean | null, code: boolean): void => {
    if (data === null || data === code) return;
    const id = model.toLowerCase();
    const key = `${id}|${field}`;
    if (shadowDiffs.has(key)) return;
    shadowDiffs.set(key, { model: id, field, data, code, seenAt: new Date() });
    console.log(`[traits-shadow] ${id} ${field}: data=${String(data)} code=${String(code)}`);
};

/** PR2 runtime: return the code result; compare with the data result when shadowed */
const runtimeWithShadow = (model: string, field: TraitField, code: boolean): boolean => {
    if (traitsShadowEnabled()) recordShadowDiff(model, field, dataTraitValuesOf(model)[field], code);
    return code;
};

export const runtimeIsImageOutputModel = (model: string): boolean =>
    runtimeWithShadow(model, 'imageOutput', codeIsImageOutputModel(model));

export const runtimeSupportsXhighThinkingLevel = (model: string): boolean =>
    runtimeWithShadow(model, 'xhighThinking', codeSupportsXhighThinkingLevel(model));

export const runtimeSupportsGeminiFunctionTools = (model: string): boolean =>
    runtimeWithShadow(model, 'geminiFunctionTools', codeSupportsGeminiFunctionTools(model));

/** Not switched in this PR: the image-search grounding list stays code */
export const supportsGeminiImageSearchGrounding = (model: string): boolean =>
    codeSupportsGeminiImageSearchGrounding(model);
