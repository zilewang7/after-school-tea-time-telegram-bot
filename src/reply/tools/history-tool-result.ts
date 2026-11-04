/**
 * Tool results for the history tools: text only, never media.
 */
import type { ToolResult } from '../../ai/tools/tool-types.js';

export const historyToolError = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

export const historyToolSuccess = (content: string): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
});
