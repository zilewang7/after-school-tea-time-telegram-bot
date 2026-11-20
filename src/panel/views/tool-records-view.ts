/**
 * A reply version's tool and search records as structured JSON, merged the way
 * the Telegram rendering merges them (telegram/formatters/tool-records-formatter.ts):
 * call lines deduplicated in call order, sources deduplicated by URL across
 * all tool steps (a URL-only entry keeps the title another step found), and
 * Gemini's search grounding kept apart, one entry per step.
 *
 * A version stored after the per-call log exists (design 2026-1119-1835) also
 * carries its executed calls as-is, in call order; older versions have none and
 * keep the grounding-derived lines.
 *
 * The stored versions are JSON written long ago and typed `any`, so every
 * field is read through a guard; whatever does not fit is skipped.
 */
import type { AgentStats, AgentToolCallRecord, AgentToolUsage, GroundingCitation, GroundingData } from '../../ai/types.js';
import { isSearchGroundingStep } from '../../telegram/formatters/google-search-formatter.js';
import { isJsonRecord, type JsonRecord } from '../json.js';

export interface ToolUsageView {
    name: string;
    /** Calls made, failed ones included */
    count: number;
    /** Of those, how many the tool answered with an error */
    failed: number;
}

export interface SourceView {
    uri: string;
    title: string | null;
}

/** One search-grounding step (Gemini's built-in search) */
export interface SearchGroundingView {
    queries: string[];
    imageQueries: string[];
    sources: SourceView[];
}

/** One clickable span of a call's display line, e.g. `h45` → its archived message */
export interface ToolCallLinkView {
    text: string;
    url: string;
}

/** One executed tool call of a version's per-call log */
export interface ToolCallView {
    name: string;
    /** Display form of the arguments, already truncated; null when the tool had none */
    argument: string | null;
    /** Display form of the outcome, already truncated; null when there is none */
    result: string | null;
    /** The tool answered with an error */
    failed: boolean;
    /** Wall time of the handler; null when not reported */
    ms: number | null;
    /** Clickable spans of the line; empty on versions stored before they existed */
    links: ToolCallLinkView[];
}

export interface ToolRecordsView {
    /** Agent mode, when the platform reports one */
    mode: string | null;
    toolUsage: ToolUsageView[];
    /** One line per distinct tool call, e.g. `search_history: 关键词`, in call order */
    calls: string[];
    /** One entry per executed call, in call order; empty on versions stored before the log existed */
    callLog: ToolCallView[];
    /** Calls the record safety cap dropped; 0 normally */
    toolCallsTruncated: number;
    /** Sources cited by the tool steps, one per URL, first-seen order */
    sources: SourceView[];
    /** Code interpreter summaries, as reported */
    codeInterpreter: string[];
    searches: SearchGroundingView[];
}

const stringsIn = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const optionalStringOf = (record: JsonRecord, key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
};

const recordsIn = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value.filter(isJsonRecord) : []);

const toCitation = (record: JsonRecord): GroundingCitation | null => {
    const uri = optionalStringOf(record, 'uri');
    if (uri === undefined) return null;
    const title = optionalStringOf(record, 'title');
    return title === undefined ? { uri } : { uri, title };
};

type GroundingChunk = NonNullable<GroundingData['groundingChunks']>[number];

const toGroundingChunk = (record: JsonRecord): GroundingChunk => {
    const web = isJsonRecord(record.web) ? record.web : null;
    const image = isJsonRecord(record.image) ? record.image : null;
    return {
        ...(web !== null ? { web: { uri: optionalStringOf(web, 'uri'), title: optionalStringOf(web, 'title') } } : {}),
        ...(image !== null
            ? {
                  image: {
                      sourceUri: optionalStringOf(image, 'sourceUri'),
                      title: optionalStringOf(image, 'title'),
                      domain: optionalStringOf(image, 'domain'),
                  },
              }
            : {}),
    };
};

type GroundingProvider = NonNullable<GroundingData['provider']>;

const PROVIDERS: readonly GroundingProvider[] = ['google', 'xai', 'mcp', 'anthropic'];

const isProvider = (value: unknown): value is GroundingProvider =>
    typeof value === 'string' && PROVIDERS.some((provider) => provider === value);

/** One stored grounding step, as far as the merge reads it */
const toGroundingStep = (record: JsonRecord): GroundingData => {
    const citations = recordsIn(record.citations)
        .map(toCitation)
        .filter((citation): citation is GroundingCitation => citation !== null);
    return {
        ...(isProvider(record.provider) ? { provider: record.provider } : {}),
        searchQueries: stringsIn(record.searchQueries),
        imageSearchQueries: stringsIn(record.imageSearchQueries),
        citations,
        groundingChunks: recordsIn(record.groundingChunks).map(toGroundingChunk),
    };
};

const toToolUsage = (record: JsonRecord): AgentToolUsage | null => {
    const name = optionalStringOf(record, 'name');
    const count = record.count;
    if (name === undefined || typeof count !== 'number') return null;
    const failed = record.failed;
    return typeof failed === 'number' ? { name, count, failed } : { name, count };
};

/** One stored clickable span; only http(s) targets survive the guard */
const toToolCallLink = (record: JsonRecord): ToolCallLinkView | null => {
    const text = optionalStringOf(record, 'text');
    const url = optionalStringOf(record, 'url');
    if (text === undefined || text === '' || url === undefined) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return { text, url };
};

/** One stored per-call record; a record without a tool name is skipped */
const toToolCall = (record: JsonRecord): AgentToolCallRecord | null => {
    const name = optionalStringOf(record, 'name');
    if (name === undefined || name === '') return null;
    const argument = optionalStringOf(record, 'argument');
    const result = optionalStringOf(record, 'result');
    const ms = record.ms;
    const links = recordsIn(record.links)
        .map(toToolCallLink)
        .filter((link): link is ToolCallLinkView => link !== null);
    return {
        name,
        ...(argument !== undefined ? { argument } : {}),
        ...(result !== undefined ? { result } : {}),
        // A failed record says so; absent and false both mean the call succeeded
        ...(record.failed === true ? { failed: true } : {}),
        ...(typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
        ...(links.length > 0 ? { links } : {}),
    };
};

/** The dropped-record count; absent when nothing was dropped */
const toTruncatedCount = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** The stored agentStats, as far as the panel shows it; null when absent or malformed */
export const parseAgentStats = (value: unknown): AgentStats | null => {
    if (!isJsonRecord(value)) return null;
    const mode = optionalStringOf(value, 'mode');
    const reasoningTokens = value.reasoningTokens;
    const toolCalls = recordsIn(value.toolCalls)
        .map(toToolCall)
        .filter((call): call is AgentToolCallRecord => call !== null);
    const toolCallsTruncated = toTruncatedCount(value.toolCallsTruncated);
    return {
        ...(mode !== undefined ? { mode } : {}),
        ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
        toolUsage: recordsIn(value.toolUsage)
            .map(toToolUsage)
            .filter((usage): usage is AgentToolUsage => usage !== null),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolCallsTruncated !== undefined ? { toolCallsTruncated } : {}),
        codeInterpreterSummary: stringsIn(value.codeInterpreterSummary),
    };
};

/** The stored groundingData list, malformed entries dropped */
export const parseGroundingSteps = (value: unknown): GroundingData[] => recordsIn(value).map(toGroundingStep);

/** Usage counts with the failures spelled out, zero-count entries dropped */
export const toToolUsageViews = (stats: AgentStats | null): ToolUsageView[] =>
    (stats?.toolUsage ?? [])
        .filter((usage) => usage.name && usage.count > 0)
        .map((usage) => ({ name: usage.name, count: usage.count, failed: usage.failed ?? 0 }));

/** Executed calls in call order, with every optional field spelled out */
const toToolCallViews = (stats: AgentStats | null): ToolCallView[] =>
    (stats?.toolCalls ?? []).map((call) => ({
        name: call.name,
        argument: call.argument ?? null,
        result: call.result ?? null,
        failed: call.failed === true,
        ms: call.ms ?? null,
        links: (call.links ?? []).map((link) => ({ text: link.text, url: link.url })),
    }));

const distinct = (lines: readonly string[]): string[] => {
    const seen = new Set<string>();
    return lines.filter((line) => {
        if (!line || seen.has(line)) return false;
        seen.add(line);
        return true;
    });
};

/** xai and mcp fill `citations`; a step may carry grounding chunks as well */
const sourcesOfStep = (step: GroundingData): GroundingCitation[] => [
    ...(step.citations ?? []),
    ...(step.groundingChunks ?? []).flatMap((chunk) => {
        if (chunk.web?.uri) return [{ uri: chunk.web.uri, title: chunk.web.title }];
        // An image chunk cites the page the image came from, not the CDN copy
        if (chunk.image?.sourceUri) {
            return [{ uri: chunk.image.sourceUri, title: chunk.image.title ?? chunk.image.domain }];
        }
        return [];
    }),
];

/** One entry per URL, first-seen order; a URL-only entry takes a later title */
const mergeSources = (citations: readonly GroundingCitation[]): SourceView[] => {
    const byUri = new Map<string, SourceView>();
    for (const citation of citations) {
        if (!citation.uri) continue;
        const title = citation.title?.trim() ? citation.title : null;
        const known = byUri.get(citation.uri);
        if (known === undefined) {
            byUri.set(citation.uri, { uri: citation.uri, title });
        } else if (known.title === null && title !== null) {
            known.title = title;
        }
    }
    return [...byUri.values()];
};

const toSearchGroundingView = (step: GroundingData): SearchGroundingView => ({
    queries: step.searchQueries.filter((query) => query.trim().length > 0),
    imageQueries: (step.imageSearchQueries ?? []).filter((query) => query.trim().length > 0),
    sources: mergeSources(sourcesOfStep(step)),
});

export const buildToolRecordsView = (agentStatsValue: unknown, groundingValue: unknown): ToolRecordsView => {
    const stats = parseAgentStats(agentStatsValue);
    const steps = parseGroundingSteps(groundingValue);
    const toolSteps = steps.filter((step) => !isSearchGroundingStep(step));
    return {
        mode: stats?.mode ?? null,
        toolUsage: toToolUsageViews(stats),
        calls: distinct(toolSteps.flatMap((step) => step.searchQueries.filter((query) => query.trim().length > 0))),
        callLog: toToolCallViews(stats),
        toolCallsTruncated: stats?.toolCallsTruncated ?? 0,
        sources: mergeSources(toolSteps.flatMap(sourcesOfStep)),
        codeInterpreter: (stats?.codeInterpreterSummary ?? []).map((summary) => summary.trim()).filter(Boolean),
        searches: steps.filter(isSearchGroundingStep).map(toSearchGroundingView),
    };
};
