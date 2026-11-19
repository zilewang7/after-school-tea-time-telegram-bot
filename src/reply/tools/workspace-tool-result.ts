/**
 * Result helpers of the workspace tools: a plain text result, or an error the
 * model can act on (the same shape the media tools use).
 */
import type { ToolCallTrace, ToolResult } from '../../ai/tools/tool-types.js';

export const workspaceToolError = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
});

export const workspaceToolSuccess = (
    content: string,
    modelImages: ToolResult['modelImages'] = [],
    trace?: ToolCallTrace
): ToolResult => ({
    content,
    isError: false,
    images: [],
    ...(modelImages.length > 0 ? { modelImages } : {}),
    record: null,
    ...(trace === undefined ? {} : { trace }),
});
