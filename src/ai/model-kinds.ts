/**
 * Model kind predicates shared by the platform factory, platforms and settings.
 *
 * Thin delegates of `model-traits.ts`: callers that already resolved
 * `RuntimeTraits` for the reply pass it in so each model is resolved once.
 */
import { isImageOutputModelFromTraits, resolveRuntimeTraits } from './model-traits.js';
import type { RuntimeTraits } from './types.js';

/**
 * Models whose output is an image (the Nano Banana and dall-e ids carry no
 * `image` in them). They serve generate_image and the /pic commands only,
 * never as the chat model: a missed one would take a chat request as an image
 * prompt.
 */
export const isImageOutputModel = (model: string, traits?: RuntimeTraits): boolean =>
    isImageOutputModelFromTraits(traits ?? resolveRuntimeTraits(model));

/** Gemini models that accept function declarations alongside the search tools */
export const supportsGeminiFunctionTools = (model: string, traits?: RuntimeTraits): boolean =>
    (traits ?? resolveRuntimeTraits(model)).geminiToolsMixing.value;

/** Image models that can ground a generation in real web images (imageSearch) */
export const supportsGeminiImageSearchGrounding = (model: string, traits?: RuntimeTraits): boolean =>
    (traits ?? resolveRuntimeTraits(model)).imageSearchGrounding.value;
