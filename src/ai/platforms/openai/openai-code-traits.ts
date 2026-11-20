/**
 * Pure code-heuristic capability defaults for OpenAI / relay models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
import { OPENAI_IMAGE_MODEL } from '../../../config/models.js';

export interface OpenAICodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean;
}

const OPENAI_REASONING_PREFIXES: readonly string[] = ['gpt-5', 'gpt-6', 'o1', 'o3', 'o4'];

const isOpenAIReasoningModel = (id: string): boolean => {
    if (id.includes('chat')) return false;
    return OPENAI_REASONING_PREFIXES.some((prefix) => id.startsWith(prefix));
};

export const openaiCodeTraitsOf = (model: string): OpenAICodeTraits => {
    const id = model.toLowerCase();
    const imageOutput =
        id === OPENAI_IMAGE_MODEL.toLowerCase() ||
        id.includes('image') ||
        id.startsWith('dall-e') ||
        id.includes('nano-banana');
    return {
        imageOutput,
        imageInput: true,
        mediaInput: false,
        clientTools: !imageOutput,
        requiresMessageMerge: false,
        supportsThinking: isOpenAIReasoningModel(id),
    };
};
