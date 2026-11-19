/**
 * Tool results for the history tools: text only, never media.
 */
import type { ToolCallTrace, ToolResult } from '../../ai/tools/tool-types.js';

export const historyToolError = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
});

export const historyToolSuccess = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
});
