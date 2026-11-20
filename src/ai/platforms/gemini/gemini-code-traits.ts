/**
 * Pure code-heuristic capability defaults for Gemini models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
import { match, P } from 'ts-pattern';
import { GEMINI_IMAGE_MODEL } from '../../../config/models.js';

export interface GeminiCodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly geminiToolsMixing: boolean;
    readonly imageSearchGrounding: boolean;
    readonly xhighThinking: boolean;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean;
    readonly supportsVideoToolResult: boolean;
}

const KNOWN_GEMINI_IMAGE_MODELS: ReadonlySet<string> = new Set([
    GEMINI_IMAGE_MODEL.toLowerCase(),
    'gemini-3-pro-image',
]);

/** Gemini 2.x models only accept the built-in search tools (400 with declarations) */
const GEMINI_SEARCH_ONLY_MODELS: ReadonlySet<string> = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
]);

const GEMINI_IMAGE_SEARCH_GROUNDING_MODELS: ReadonlySet<string> = new Set([
    'gemini-nano-banana-2.1',
    'gemini-3.1-flash-image',
]);

export const isGeminiCodeImageOutput = (id: string): boolean =>
    match(id)
        .when((value) => KNOWN_GEMINI_IMAGE_MODELS.has(value), () => true)
        .with(P.string.includes('image'), () => true)
        .with(P.string.includes('nano-banana'), () => true)
        .otherwise(() => false);

export const geminiCodeTraitsOf = (model: string): GeminiCodeTraits => {
    const id = model.toLowerCase();
    const imageOutput = isGeminiCodeImageOutput(id);
    const toolsMixing = !imageOutput && !GEMINI_SEARCH_ONLY_MODELS.has(id);
    return {
        imageOutput,
        imageInput: true,
        mediaInput: !imageOutput,
        clientTools: toolsMixing,
        geminiToolsMixing: toolsMixing,
        imageSearchGrounding: GEMINI_IMAGE_SEARCH_GROUNDING_MODELS.has(id),
        xhighThinking: id.startsWith('gemini-4-hydrogen') || id.startsWith('gemini-4-neon'),
        requiresMessageMerge: false,
        supportsThinking: true,
        supportsVideoToolResult: true,
    };
};
