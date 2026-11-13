/**
 * Model kind predicates shared by the platform factory and the platforms.
 *
 * The predicates are thin delegates of `model-traits.ts`: PR2 still returns the
 * code heuristics (with the data comparison only logged under
 * `MODEL_TRAITS_SHADOW=1`). Export names and semantics stay as they were, so the
 * ten-plus call sites do not change.
 */
import { platformTypeOf } from './platform-routing.js';
import {
    runtimeIsImageOutputModel,
    runtimeSupportsGeminiFunctionTools,
    runtimeSupportsXhighThinkingLevel,
    supportsGeminiImageSearchGrounding as supportsGeminiImageSearchGroundingTrait,
} from './model-traits.js';

/**
 * Models whose output is an image (the Nano Banana ids carry no `image` in
 * them; a missed image model rejects the chat persona with 400).
 */
export const isImageOutputModel = (model: string): boolean => runtimeIsImageOutputModel(model);

/**
 * Models whose chat system prompt is thrown away: on Gemini an image model's
 * systemInstruction is replaced wholesale by the image-generation instruction,
 * so the static head (and its note announcing the chat's prompt addendum) never
 * arrives. The addendum is then left out of the runtime block, where it would
 * read as part of the image description. OpenAI's image model keeps the full
 * static head and gets the addendum as usual.
 */
export const replacesChatSystemPrompt = (model: string): boolean =>
    isImageOutputModel(model) && platformTypeOf(model) === 'gemini';

/** Gemini models that accept function declarations alongside the search tools */
export const supportsGeminiFunctionTools = (model: string): boolean =>
    runtimeSupportsGeminiFunctionTools(model);

/** Image models that can ground a generation in real web images (imageSearch) */
export const supportsGeminiImageSearchGrounding = (model: string): boolean =>
    supportsGeminiImageSearchGroundingTrait(model);

/** Gemini 4 Hydrogen accepts the XHIGH thinking level on Vertex */
export const supportsXhighThinkingLevel = (model: string): boolean =>
    runtimeSupportsXhighThinkingLevel(model);
