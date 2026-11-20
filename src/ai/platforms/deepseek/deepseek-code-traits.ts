/**
 * Pure code-heuristic capability defaults for DeepSeek models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
export interface DeepSeekCodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly requiresMessageMerge: boolean;
}

export const deepseekCodeTraitsOf = (model: string): DeepSeekCodeTraits => {
    const id = model.toLowerCase();
    return {
        imageOutput: false,
        imageInput: id.includes('vision') || id.includes('image') || id === 'deepseek-flash',
        mediaInput: false,
        clientTools: true,
        requiresMessageMerge: id.includes('reasoner'),
    };
};
