/**
 * Pure code-heuristic capability defaults for MiMo models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
export interface MimoCodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean;
}

export const mimoCodeTraitsOf = (model: string): MimoCodeTraits => {
    const id = model.toLowerCase();
    return {
        imageOutput: false,
        imageInput: id !== 'mimo-v2.5-pro',
        mediaInput: id.startsWith('mimo-v2.6'),
        clientTools: true,
        requiresMessageMerge: false,
        supportsThinking: true,
    };
};
