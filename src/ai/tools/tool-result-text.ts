/**
 * The text a client tool result reaches the model as, on the platforms that
 * hand results back as plain text (OpenAI, Anthropic, DeepSeek, MiMo).
 */
import type { ToolResult } from './tool-types.js';

/** `result.content` verbatim; errors carry a prefix so the model can tell them apart */
export const toolResultText = (result: ToolResult): string =>
    result.isError ? `Error: ${result.content}` : result.content;
