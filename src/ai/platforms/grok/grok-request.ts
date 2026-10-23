/**
 * Grok (xAI) Responses API requests: the server-side search tools, the client
 * function tools, the round-1 fallback candidates and the continuation of a
 * client tool round.
 */
import type {
    FunctionTool,
    ResponseCreateParamsStreaming,
    ResponseInputItem,
} from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';
import {
    imageDataUrl,
    modelImagesIntro,
    modelImagesOf,
    toResponsesFunctionTools,
    toolResultText,
    type ExecutedToolCall,
    type ToolCall,
    type ToolDefinition,
    type ToolResult,
} from '../../tools/index.js';

type GrokWebSearchTool = {
    type: 'web_search';
    enable_image_understanding?: boolean;
};

type GrokXSearchTool = {
    type: 'x_search';
    enable_image_understanding?: boolean;
    enable_video_understanding?: boolean;
};

type GrokCodeInterpreterTool = {
    type: 'code_interpreter';
};

/** A client function tool the way xAI documents it: no `strict`, which the SDK type insists on */
export type GrokFunctionTool = Omit<FunctionTool, 'strict'>;

export type GrokResponseTool =
    | NonNullable<ResponseCreateParamsStreaming['tools']>[number]
    | GrokWebSearchTool
    | GrokXSearchTool
    | GrokCodeInterpreterTool
    | GrokFunctionTool;

export type GrokResponseRequest = Omit<ResponseCreateParamsStreaming, 'tools' | 'reasoning'> & {
    tools: GrokResponseTool[];
    reasoning?: {
        effort: 'high';
    };
    max_turns?: number;
};

export const isGrokMultiAgentModel = (model: string): boolean =>
    model.toLowerCase().includes('multi-agent');

export const grokReasoningFor = (model: string): GrokResponseRequest['reasoning'] =>
    isGrokMultiAgentModel(model) ? { effort: 'high' } : undefined;

export const buildSearchTools = (): GrokResponseTool[] => [
    {
        type: 'web_search',
        enable_image_understanding: true,
    },
    {
        type: 'x_search',
        enable_image_understanding: true,
        enable_video_understanding: true,
    },
    {
        type: 'code_interpreter',
    },
];

/** The turn's tool definitions as xAI function tools; the schema loses its `$schema` key */
export const toGrokFunctionTools = (definitions: readonly ToolDefinition[]): GrokFunctionTool[] =>
    toResponsesFunctionTools(definitions).map(({ type, name, description, parameters }) => ({
        type,
        name,
        description,
        parameters,
    }));

/** Names of the function tools a request offers */
export const functionToolNames = (tools: readonly GrokResponseTool[]): string[] =>
    tools.flatMap((tool) => (tool.type === 'function' ? [tool.name] : []));

/** Tool list for logs: function tools by name, the rest by type */
export const describeTools = (tools: readonly GrokResponseTool[]): string[] =>
    tools.map((tool) => (tool.type === 'function' ? `function:${tool.name}` : tool.type));

/** The search-tool candidates, most feature-rich first, without duplicates */
const buildSearchCandidates = (request: GrokResponseRequest): GrokResponseRequest[] => {
    const plainComprehensiveTools: GrokResponseTool[] = [
        { type: 'web_search' },
        { type: 'x_search' },
        { type: 'code_interpreter' },
    ];
    const plainSearchTools: GrokResponseTool[] = [
        { type: 'web_search' },
        { type: 'x_search' },
    ];
    const webOnlyTools: GrokResponseTool[] = [{ type: 'web_search' }];

    const candidates: GrokResponseRequest[] = [
        request,
        {
            ...request,
            max_turns: undefined,
        },
        {
            ...request,
            tools: plainComprehensiveTools,
        },
        {
            ...request,
            tools: plainSearchTools,
            max_turns: undefined,
        },
        {
            ...request,
            tools: webOnlyTools,
            max_turns: undefined,
        },
        {
            ...request,
            tools: webOnlyTools,
            reasoning: undefined,
            max_turns: undefined,
        },
    ];

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const signature = JSON.stringify({
            tools: candidate.tools,
            reasoning: candidate.reasoning,
            max_turns: candidate.max_turns ?? null,
            parallel_tool_calls: candidate.parallel_tool_calls ?? null,
        });
        if (seen.has(signature)) {
            return false;
        }
        seen.add(signature);
        return true;
    });
};

/**
 * The requests round 1 tries in order; an unsupported-feature 400 moves on to
 * the next. With client tools every candidate carries them, and one last
 * candidate goes without, so a rejected function schema still gets an answer.
 */
export const buildCandidateRequests = (
    request: GrokResponseRequest,
    functionTools: readonly GrokFunctionTool[]
): GrokResponseRequest[] => {
    const searchCandidates = buildSearchCandidates(request);
    if (functionTools.length === 0) return searchCandidates;

    return [
        ...searchCandidates.map((candidate) => ({
            ...candidate,
            tools: [...candidate.tools, ...functionTools],
        })),
        request,
    ];
};

const UNSUPPORTED_FEATURE_PATTERNS = [
    'tool',
    'function',
    'schema',
    'x_search',
    'web_search',
    'code_interpreter',
    'reasoning',
    'max_turns',
    'parallel_tool_calls',
    'enable_image_understanding',
    'enable_video_understanding',
    'unsupported',
    'unknown parameter',
    'invalid parameter',
];

const messageOf = (value: unknown): string =>
    isJsonObject(value) && typeof value.message === 'string' ? value.message : '';

/** A 400 that names a request feature: worth retrying round 1 with the next candidate */
export const isUnsupportedFeatureError = (error: unknown): boolean => {
    if (!isJsonObject(error) || error.status !== 400) {
        return false;
    }

    const message = `${messageOf(error)} ${messageOf(error.error)}`.toLowerCase();
    return UNSUPPORTED_FEATURE_PATTERNS.some((pattern) => message.includes(pattern));
};

/** The answer to a function call naming a tool the request did not offer; it never runs */
const notOfferedResult = (name: string): ToolResult => ({
    content: `Unknown tool ${name}`,
    isError: true,
    images: [],
    record: null,
});

/**
 * One function_call_output per function call of the round, in call order, so
 * no call is left unanswered: an executed call carries its result, any other
 * call (a tool the request did not offer) an error.
 */
export const buildFunctionCallOutputs = (
    functionCalls: readonly ToolCall[],
    executedCalls: readonly ExecutedToolCall[]
): ResponseInputItem.FunctionCallOutput[] => {
    // runToolRound hands back the very call objects it was given
    const resultsByCall = new Map<ToolCall, ToolResult>(executedCalls.map(({ call, result }) => [call, result]));

    return functionCalls.map((call): ResponseInputItem.FunctionCallOutput => ({
        type: 'function_call_output',
        call_id: call.id,
        output: toolResultText(resultsByCall.get(call) ?? notOfferedResult(call.name)),
    }));
};

/**
 * The round after a client tool round: chained to the last response, its
 * function_call_output items as input, and otherwise the accepted round-1
 * candidate as it was (tools, max_turns, reasoning), so a 400 here is never
 * mistaken for an unsupported feature. The final round keeps the tools
 * declared but switches them off.
 */
export const buildContinuationRequest = (
    acceptedRequest: GrokResponseRequest,
    previousResponseId: string,
    functionCallOutputs: readonly ResponseInputItem.FunctionCallOutput[],
    final: boolean,
    extraInput: readonly ResponseInputItem[] = []
): GrokResponseRequest => ({
    ...acceptedRequest,
    previous_response_id: previousResponseId,
    input: [...functionCallOutputs, ...extraInput],
    tool_choice: final ? 'none' : undefined,
});

/**
 * The pictures a tool round produced. xAI's input list takes a plain message
 * with input_image parts after the function outputs, which keeps the outputs
 * themselves valid for their own schema.
 */
export const buildModelImagesInput = (
    executedCalls: readonly ExecutedToolCall[]
): ResponseInputItem[] => {
    const images = modelImagesOf(executedCalls);
    if (images.length === 0) return [];

    return [
        {
            type: 'message',
            role: 'user',
            content: [
                { type: 'input_text', text: modelImagesIntro(images) },
                ...images.map((image) => ({
                    type: 'input_image' as const,
                    image_url: imageDataUrl(image),
                    detail: 'auto' as const,
                })),
            ],
        },
    ];
};
