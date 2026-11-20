/**
 * Pure code-heuristic capability defaults for Grok (xAI) models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
export interface GrokCodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly requiresMessageMerge: boolean;
}

export const grokCodeTraitsOf = (model: string): GrokCodeTraits => {
    const id = model.toLowerCase();
    const noImageSupport = id.startsWith('grok-3') || id.startsWith('grok-code');
    return {
        imageOutput: false,
        imageInput: !noImageSupport,
        mediaInput: false,
        clientTools: !id.includes('multi-agent'),
        requiresMessageMerge: false,
    };
};
