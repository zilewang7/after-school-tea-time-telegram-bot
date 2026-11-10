/**
 * Model kind predicates shared by the platform factory and the platforms.
 *
 * Lives apart from platform-factory because the factory imports every platform
 * (and instantiates them at module load); a platform asking the factory "is this
 * an image model?" would close an import cycle.
 */
import { match, P } from 'ts-pattern';
import { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../config/models.js';
import { platformTypeOf } from './platform-routing.js';

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

export const isImageOutputModel = (model: string): boolean =>
    match(model.toLowerCase())
        .when((id) => KNOWN_IMAGE_MODELS.has(id), () => true)
        .with(P.string.includes('image'), () => true)
        .with(P.string.includes('nano-banana'), () => true)
        .otherwise(() => false);

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

/**
 * Gemini models verified to accept function declarations alongside the built-in
 * search tools (2026-10-16, own Vertex project; gemini-4-carbon verified
 * 2026-11-11: two-round loop with reply, thinking and flat text all pass).
 * Everything older answers "Multiple tools are supported only when they are all
 * search tools" with 400, so they are denied by name instead of the new ones
 * having to be admitted one by one.
 */
const GEMINI_SEARCH_ONLY_MODELS: ReadonlySet<string> = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
    'gemini-3.1-pro-preview',
]);

export const supportsGeminiFunctionTools = (model: string): boolean => {
    const id = model.toLowerCase();
    return isImageOutputModel(id) === false && GEMINI_SEARCH_ONLY_MODELS.has(id) === false;
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

export const supportsGeminiImageSearchGrounding = (model: string): boolean =>
    GEMINI_IMAGE_SEARCH_GROUNDING_MODELS.has(model.toLowerCase());
