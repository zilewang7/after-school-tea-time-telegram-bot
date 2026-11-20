/**
 * Pure code-heuristic capability defaults for Anthropic (Claude) models.
 * No SDK imports and no imports from `model-traits.ts` / `model-kinds.ts`.
 */
export interface AnthropicCodeTraits {
    readonly imageOutput: boolean;
    readonly imageInput: boolean;
    readonly mediaInput: boolean;
    readonly clientTools: boolean;
    readonly requiresMessageMerge: boolean;
    readonly supportsThinking: boolean;
}

export const anthropicCodeTraitsOf = (_model: string): AnthropicCodeTraits => ({
    imageOutput: false,
    imageInput: true,
    mediaInput: false,
    clientTools: true,
    requiresMessageMerge: false,
    supportsThinking: true,
});
