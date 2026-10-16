/**
 * The request of one Gemini tool loop round: the built-in search tools plus
 * the turn's function declarations, and the final round's "answer now" switch.
 */
import { match, P } from 'ts-pattern';
import {
    FunctionCallingConfigMode,
    type Content,
    type GenerateContentConfig,
    type Tool,
} from '@google/genai';
import type { ToolDefinition } from '../../tools/tool-types.js';
import { toGeminiFunctionDeclarations } from '../../tools/tool-wire-formats.js';

export interface GeminiRoundRequest {
    readonly contents: readonly Content[];
    readonly tools: readonly Tool[];
    /** The model must answer now: function calling is switched off (mode NONE) */
    readonly final: boolean;
}

/**
 * googleSearch + urlContext + every declaration in ONE Tool object. The
 * search tools stay first and unchanged, so a chat keeps the same tool prefix
 * it had before client tools existed.
 */
export const toGeminiToolList = (definitions: readonly ToolDefinition[]): Tool[] => [
    { googleSearch: {} },
    { urlContext: {} },
    { functionDeclarations: toGeminiFunctionDeclarations(definitions) },
];

export const hasFunctionDeclarations = (tools: readonly Tool[]): boolean =>
    tools.some((tool) => tool.functionDeclarations !== undefined);

/** The built-in search tools alone, as every request carried before client tools */
export const withoutFunctionDeclarations = (tools: readonly Tool[]): Tool[] =>
    tools.filter((tool) => tool.functionDeclarations === undefined);

/**
 * The SDK config of one round. includeServerSideToolInvocations is never set:
 * the SDK rejects it on Vertex before sending anything.
 */
export const toRoundConfig = (
    baseConfig: GenerateContentConfig,
    request: GeminiRoundRequest
): GenerateContentConfig => ({
    ...baseConfig,
    tools: [...request.tools],
    ...(request.final && hasFunctionDeclarations(request.tools)
        ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } }
        : {}),
});

/** HTTP status of an SDK error (ApiError carries `status`), when it has one */
export const httpStatusOf = (error: unknown): number | undefined =>
    match(error)
        .with({ status: P.number }, ({ status }) => status)
        .otherwise(() => undefined);

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * 400s that blame the declarations: a schema Vertex cannot read
 * (function_declarations / parameters_json_schema field paths), function
 * calling being unavailable, or a model that only combines search tools.
 */
const FUNCTION_DECLARATION_ERROR =
    /function[_\s]?declarations?|parameters_?json_?schema|function[_\s]?calling|all search tools/i;

export const isFunctionDeclarationError = (error: unknown): boolean =>
    httpStatusOf(error) === 400 && FUNCTION_DECLARATION_ERROR.test(errorText(error));
