/**
 * The tool snapshot of one turn: only the tools offered to this turn can run,
 * so a hallucinated tool name comes back as an error result instead.
 */
import { isJsonObject } from '../../shared/json-object.js';
import type { ToolStatus } from '../types.js';
import type { ToolCall, ToolHandler, ToolResult, TurnTools } from './tool-types.js';

const errorResult = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

/** null = not a JSON object; the parse error is dropped because it quotes the input */
const parseToolArguments = (argumentsJson: string): Readonly<Record<string, unknown>> | null => {
    if (argumentsJson.trim() === '') return {};
    try {
        const parsed: unknown = JSON.parse(argumentsJson);
        return isJsonObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const indexHandlersByName = (handlers: readonly ToolHandler[]): ReadonlyMap<string, ToolHandler> => {
    const handlersByName = new Map<string, ToolHandler>();
    for (const handler of handlers) {
        const { name } = handler.definition;
        if (handlersByName.has(name)) {
            console.warn(`[tools] Duplicate tool name ${name}, keeping the first handler`);
            continue;
        }
        handlersByName.set(name, handler);
    }
    return handlersByName;
};

const runHandler = async (
    handler: ToolHandler | undefined,
    call: ToolCall,
    signal: AbortSignal | undefined
): Promise<ToolResult> => {
    if (!handler) return errorResult(`Unknown tool ${call.name}`);

    const args = parseToolArguments(call.argumentsJson);
    if (!args) return errorResult(`Invalid arguments for ${call.name}: expected a JSON object`);

    // A stopped reply must not start tools with side effects
    if (signal?.aborted) return errorResult(`Tool ${call.name} was not run: the reply was stopped`);

    // A child signal per call: the listeners a handler adds die with its call
    // instead of piling up on the reply's stop signal
    const callSignal = signal ? AbortSignal.any([signal]) : new AbortController().signal;
    try {
        return await handler.execute(args, callSignal);
    } catch (error) {
        return errorResult(`Tool ${call.name} failed: ${describeError(error)}`);
    }
};

export const createTurnTools = (handlers: readonly ToolHandler[]): TurnTools => {
    const handlersByName = indexHandlersByName(handlers);

    return {
        definitions: Array.from(handlersByName.values(), (handler) => handler.definition),
        execute: async (call, signal) => {
            const startedAt = Date.now();
            const result = await runHandler(handlersByName.get(call.name), call, signal);
            // Never log the arguments: they may carry secrets or private text
            console.log(
                `[tools] ${call.name} took ${Date.now() - startedAt}ms, isError=${result.isError}`
            );
            return result;
        },
        statusOf: (name): ToolStatus => {
            const handler = handlersByName.get(name);
            return {
                text: handler?.statusText ?? `⚙ 正在调用 ${name}…`,
                chatAction: handler?.chatAction ?? 'typing',
            };
        },
    };
};

export const NO_TURN_TOOLS: TurnTools = createTurnTools([]);
