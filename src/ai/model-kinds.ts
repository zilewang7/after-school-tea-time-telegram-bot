/**
 * Model kind predicates shared by the platform factory and the platforms.
 *
 * The predicates are thin delegates of `model-traits.ts`: PR2 still returns the
 * code heuristics (with the data comparison only logged under
 * `MODEL_TRAITS_SHADOW=1`). Export names and semantics stay as they were, so the
 * ten-plus call sites do not change.
 */
import {
    runtimeIsImageOutputModel,
    runtimeSupportsGeminiFunctionTools,
    runtimeSupportsXhighThinkingLevel,
    supportsGeminiImageSearchGrounding as supportsGeminiImageSearchGroundingTrait,
} from './model-traits.js';

/**
 * Models whose output is an image (the Nano Banana and dall-e ids carry no
 * `image` in them). They serve generate_image and the /pic commands only,
 * never as the chat model: a missed one would take a chat request as an image
 * prompt.
 */
export const isImageOutputModel = (model: string): boolean => runtimeIsImageOutputModel(model);

/** Gemini models that accept function declarations alongside the search tools */
export const supportsGeminiFunctionTools = (model: string): boolean =>
    runtimeSupportsGeminiFunctionTools(model);

/** Image models that can ground a generation in real web images (imageSearch) */
export const supportsGeminiImageSearchGrounding = (model: string): boolean =>
    supportsGeminiImageSearchGroundingTrait(model);

/** Gemini 4 Hydrogen accepts the XHIGH thinking level on Vertex */
export const supportsXhighThinkingLevel = (model: string): boolean =>
    runtimeSupportsXhighThinkingLevel(model);
