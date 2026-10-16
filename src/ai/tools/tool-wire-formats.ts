/**
 * Tool definitions in each provider's wire format, plus tool name sanitizing.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { FunctionDeclaration } from '@google/genai';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';
import type { ToolDefinition } from './tool-types.js';

const TOOL_NAME_MAX_LENGTH = 64;

/** Copy of the schema without the top-level `$schema` key (OpenAI-style APIs reject it) */
export const stripSchemaMeta = (
    schema: Readonly<Record<string, unknown>>
): Record<string, unknown> =>
    Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'));

export const toChatCompletionTools = (
    definitions: readonly ToolDefinition[]
): ChatCompletionFunctionTool[] =>
    definitions.map((definition) => ({
        type: 'function',
        function: {
            name: definition.name,
            description: definition.description,
            parameters: stripSchemaMeta(definition.inputSchema),
        },
    }));

export const toResponsesFunctionTools = (
    definitions: readonly ToolDefinition[]
): FunctionTool[] =>
    definitions.map((definition) => ({
        type: 'function',
        name: definition.name,
        description: definition.description,
        parameters: stripSchemaMeta(definition.inputSchema),
        strict: false,
    }));

export const toAnthropicTools = (definitions: readonly ToolDefinition[]): Anthropic.Tool[] =>
    definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        input_schema: { ...stripSchemaMeta(definition.inputSchema), type: 'object' },
    }));

/** Schema passed verbatim: Vertex accepts `$schema` in parametersJsonSchema */
export const toGeminiFunctionDeclarations = (
    definitions: readonly ToolDefinition[]
): FunctionDeclaration[] =>
    definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        parametersJsonSchema: definition.inputSchema,
    }));

const sanitizeToolName = (rawName: string): string => {
    const allowedCharsOnly = rawName.replace(/[^A-Za-z0-9_-]/g, '_');
    const validStart = /^[A-Za-z_]/.test(allowedCharsOnly)
        ? allowedCharsOnly
        : `_${allowedCharsOnly}`;
    return validStart.slice(0, TOOL_NAME_MAX_LENGTH);
};

/**
 * A provider-safe tool name (^[A-Za-z_][A-Za-z0-9_-]{0,63}$) not in `taken`;
 * collisions get `_2`, `_3`… The caller records the returned name in its set.
 */
export const toToolName = (rawName: string, taken: ReadonlySet<string>): string => {
    const baseName = sanitizeToolName(rawName);
    if (!taken.has(baseName)) return baseName;

    for (let suffixNumber = 2; ; suffixNumber++) {
        const suffix = `_${suffixNumber}`;
        const candidate = baseName.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
};
