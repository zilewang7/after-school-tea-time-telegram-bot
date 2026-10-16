/**
 * Agent stats of one Grok reply, summed over its rounds: server-side tool
 * usage, code interpreter summaries and reasoning tokens, plus the client
 * tool calls the reply ran.
 */
import type { Response } from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';
import type { AgentStats, AgentToolUsage } from '../../types.js';
import { fieldOf, listOf } from './grok-response-fields.js';

type ToolCounts = Map<string, number>;

const addCount = (counts: ToolCounts, name: string, count: number): void => {
    if (!name) return;
    counts.set(name, (counts.get(name) ?? 0) + count);
};

const normalizeToolName = (name: string): string => {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('code') && lowerName.includes('interpreter')) {
        return 'code_interpreter';
    }
    if (lowerName.includes('x_search') || lowerName === 'xsearch') {
        return 'x_search';
    }
    if (lowerName.includes('web_search')) {
        return 'web_search';
    }

    return name;
};

const CALLS_SUFFIX = '_calls';

/**
 * `usage.server_side_tool_usage_details`: one `<tool>_calls` count per tool
 * (the fetched-item counts next to them are not calls). null when absent.
 */
const usageFromDetails = (response: Record<string, unknown>): ToolCounts | null => {
    const details = fieldOf(response.usage, 'server_side_tool_usage_details');
    if (!isJsonObject(details)) return null;

    const counts: ToolCounts = new Map();
    for (const [key, count] of Object.entries(details)) {
        if (!key.endsWith(CALLS_SUFFIX) || typeof count !== 'number' || count <= 0) continue;
        addCount(counts, normalizeToolName(key.slice(0, -CALLS_SUFFIX.length)), count);
    }
    return counts;
};

/** Server-side call items by type; xAI reports X searches as custom tool calls */
const SERVER_TOOL_BY_ITEM_TYPE: ReadonlyMap<unknown, string> = new Map([
    ['web_search_call', 'web_search'],
    ['x_search_call', 'x_search'],
    ['custom_tool_call', 'x_search'],
    ['code_interpreter_call', 'code_interpreter'],
]);

const nameOfLegacyToolCall = (toolCall: unknown): unknown =>
    fieldOf(fieldOf(toolCall, 'function'), 'name') || fieldOf(toolCall, 'name') || fieldOf(toolCall, 'type');

/** The older top-level `server_side_tool_usage`: a list of names / entries, or a name → count map */
const addLegacyServerSideUsage = (counts: ToolCounts, usage: unknown): void => {
    if (Array.isArray(usage)) {
        for (const entry of usage) {
            if (typeof entry === 'string') {
                addCount(counts, normalizeToolName(entry), 1);
                continue;
            }
            const name = fieldOf(entry, 'name') || fieldOf(entry, 'tool') || fieldOf(entry, 'type');
            const count = fieldOf(entry, 'count');
            if (typeof name === 'string') {
                addCount(counts, normalizeToolName(name), typeof count === 'number' ? count : 1);
            }
        }
        return;
    }

    if (isJsonObject(usage)) {
        for (const [name, count] of Object.entries(usage)) {
            if (typeof count === 'number') addCount(counts, normalizeToolName(name), count);
        }
    }
};

/** Without usage details: count the call items (and the older fields) */
const usageFromItems = (response: Record<string, unknown>): ToolCounts => {
    const counts: ToolCounts = new Map();

    for (const toolCall of listOf(response.tool_calls)) {
        const name = nameOfLegacyToolCall(toolCall);
        if (typeof name === 'string') addCount(counts, normalizeToolName(name), 1);
    }
    for (const item of listOf(response.output)) {
        const name = SERVER_TOOL_BY_ITEM_TYPE.get(fieldOf(item, 'type'));
        if (name) addCount(counts, name, 1);
    }

    if (counts.size === 0) {
        addLegacyServerSideUsage(counts, response.server_side_tool_usage);
    }
    return counts;
};

const summarizeCodeInterpreterCall = (item: Record<string, unknown>): string => {
    const outputs = listOf(item.outputs).filter(isJsonObject);
    const logBlocks = outputs.flatMap((output) =>
        output.type === 'logs' && typeof output.logs === 'string' ? [output.logs] : []
    );
    const imageCount = outputs.filter((output) => output.type === 'image').length;
    const firstLogLine = logBlocks
        .map((logs) =>
            logs
                .split('\n')
                .map((line) => line.trim())
                .find((line) => line.length > 0)
        )
        .find((line) => Boolean(line));

    const parts: string[] = [];
    if (logBlocks.length > 0) {
        parts.push(`${logBlocks.length} log block${logBlocks.length > 1 ? 's' : ''}`);
    }
    if (imageCount > 0) {
        parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
    }
    if (firstLogLine) {
        parts.push(firstLogLine);
    }

    if (!parts.length) {
        const status = typeof item.status === 'string' ? item.status : 'completed';
        return status === 'completed'
            ? 'completed (server-side output hidden)'
            : status;
    }

    return parts.join(' | ');
};

const codeInterpreterSummaries = (response: Record<string, unknown>): string[] =>
    listOf(response.output)
        .filter(isJsonObject)
        .filter((item) => item.type === 'code_interpreter_call')
        .map(summarizeCodeInterpreterCall);

const reasoningTokensOf = (response: Record<string, unknown>): number | undefined => {
    const tokens = fieldOf(fieldOf(response.usage, 'output_tokens_details'), 'reasoning_tokens');
    return typeof tokens === 'number' ? tokens : undefined;
};

/** Most used first, then by name */
const sortedUsage = (counts: ToolCounts): AgentToolUsage[] =>
    [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));

export interface GrokAgentStats {
    /** Count what one round's response reports */
    addResponse(response: Response): void;
    /** The reply's stats with its client tool calls; undefined when there is nothing to show */
    build(clientToolUsage: readonly AgentToolUsage[]): AgentStats | undefined;
}

export const createGrokAgentStats = (isMultiAgent: boolean): GrokAgentStats => {
    const serverToolCounts: ToolCounts = new Map();
    const codeInterpreterSummary: string[] = [];
    let reasoningTokens: number | undefined;
    let responseCount = 0;

    return {
        addResponse: (response) => {
            const raw: unknown = response;
            if (!isJsonObject(raw)) return;

            responseCount++;
            for (const [name, count] of usageFromDetails(raw) ?? usageFromItems(raw)) {
                addCount(serverToolCounts, name, count);
            }
            codeInterpreterSummary.push(...codeInterpreterSummaries(raw));
            const roundReasoningTokens = reasoningTokensOf(raw);
            if (roundReasoningTokens !== undefined) {
                reasoningTokens = (reasoningTokens ?? 0) + roundReasoningTokens;
            }
        },
        build: (clientToolUsage) => {
            if (responseCount === 0 && clientToolUsage.length === 0) {
                return undefined;
            }

            // Client tools keep their own names; only server-side names are normalized
            const toolCounts: ToolCounts = new Map(serverToolCounts);
            for (const { name, count } of clientToolUsage) {
                addCount(toolCounts, name, count);
            }

            const stats: AgentStats = {
                mode: isMultiAgent ? '16 agents' : undefined,
                reasoningTokens,
                toolUsage: sortedUsage(toolCounts),
                codeInterpreterSummary,
            };

            if (
                !stats.mode &&
                !stats.reasoningTokens &&
                !stats.toolUsage?.length &&
                !stats.codeInterpreterSummary?.length
            ) {
                return undefined;
            }

            return stats;
        },
    };
};
