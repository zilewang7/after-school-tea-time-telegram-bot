/**
 * Model kind predicates shared by the platform factory and the platforms.
 *
 * Lives apart from platform-factory because the factory imports every platform
 * (and instantiates them at module load); a platform asking the factory "is this
 * an image model?" would close an import cycle.
 */
import { match, P } from 'ts-pattern';
import { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../config/models.js';

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
 * Gemini models verified to accept function declarations alongside the built-in
 * search tools (2026-10-16, own Vertex project). Everything older answers
 * "Multiple tools are supported only when they are all search tools" with 400,
 * so the list is an allow-list rather than a version range.
 */
const GEMINI_FUNCTION_TOOL_MODELS: ReadonlySet<string> = new Set([
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.1-pro-preview',
]);

export const supportsGeminiFunctionTools = (model: string): boolean =>
    GEMINI_FUNCTION_TOOL_MODELS.has(model.toLowerCase());
