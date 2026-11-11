/**
 * Result helpers of the workspace tools: a plain text result, or an error the
 * model can act on (the same shape the media tools use).
 */
import type { ToolResult } from '../../ai/tools/tool-types.js';

export const workspaceToolError = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

export const workspaceToolSuccess = (
    content: string,
    modelImages: ToolResult['modelImages'] = []
): ToolResult => ({
    content,
    isError: false,
    images: [],
    ...(modelImages.length > 0 ? { modelImages } : {}),
    record: null,
});
