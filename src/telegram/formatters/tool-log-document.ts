/**
 * The Tools block's content as one document (design 2026-1119-1835): the
 * `tool usage:` front line, one line per executed call (or the legacy
 * grounding-derived lines for versions stored before the per-call log), the
 * code-interpreter summaries and the safety-cap note.
 *
 * The chat block, the fold plan, the link message's stats and the public log
 * page all read this one document, so the four can never disagree.
 */
import type { AgentStats, AgentToolCallRecord, AgentToolUsage, GroundingData } from '../../ai/types.js';
import {
    TOOL_LOG_ARGUMENT_MAX_CHARS,
    TOOL_LOG_RESULT_MAX_CHARS,
    TOOL_LOG_SLOW_CALL_MS,
    formatCallSeconds,
    truncateCodePoints,
} from '../../shared/tool-log.js';
import { isSearchGroundingStep } from './google-search-document.js';

/** Code-interpreter summaries are capped like before: one line, never a dump */
const SUMMARY_MAX_LENGTH = 120;

const truncate = (text: string, maxLength: number = SUMMARY_MAX_LENGTH): string =>
    text.length <= maxLength ? text : text.slice(0, maxLength - 1) + '…';

export interface ToolLogDocument {
    /** Agent mode, when the platform reports one */
    readonly mode: string | null;
    /** Usage counts with zero entries dropped, in the order the platform reported */
    readonly usage: readonly AgentToolUsage[];
    /** `tool usage: a x2 | b x1（1 次失败）`; empty when no tool ran */
    readonly usageLine: string;
    /** `code interpreter: …` lines, as the block always rendered them */
    readonly codeInterpreter: readonly string[];
    /** New per-call records, in call order; empty on versions stored before it existed */
    readonly calls: readonly AgentToolCallRecord[];
    /** Legacy per-call lines derived from groundingData (old versions only) */
    readonly legacyLines: readonly string[];
    /** `1. name: args → outcome` lines, in call order */
    readonly callLines: readonly string[];
    /** Calls the record safety cap dropped; 0 normally */
    readonly truncatedCount: number;
    /** Failed calls over all tools (the usage line's own note) */
    readonly failedCount: number;
    /** Every executed call the usage line counts, dropped records included */
    readonly totalCalls: number;
}

/** A count alone reads like that many results: say how many calls failed */
const failedNote = (failed: number | undefined): string =>
    failed !== undefined && failed > 0 ? `（${failed} 次失败）` : '';

const usageLineOf = (usage: readonly AgentToolUsage[]): string =>
    usage.length === 0
        ? ''
        : `tool usage: ${usage.map((tool) => `${tool.name} x${tool.count}${failedNote(tool.failed)}`).join(' | ')}`;

/** One call line: `3. fetch_image: h101 → img3 640×480 · 3.4s` */
const callLineOf = (record: AgentToolCallRecord, index: number): string => {
    const argument = record.argument === undefined ? '' : truncateCodePoints(record.argument, TOOL_LOG_ARGUMENT_MAX_CHARS);
    const result = record.result === undefined ? '' : truncateCodePoints(record.result, TOOL_LOG_RESULT_MAX_CHARS);
    let line = `${index + 1}. ${record.name}`;
    if (argument !== '') line += `: ${argument}`;
    if (record.failed === true) {
        line += result === '' ? ' → 失败' : ` → 失败：${result}`;
    } else if (result !== '') {
        line += ` → ${result}`;
    }
    if (record.ms !== undefined && record.ms >= TOOL_LOG_SLOW_CALL_MS) {
        line += ` · ${formatCallSeconds(record.ms)}`;
    }
    return line;
};

/** Legacy call lines: the distinct grounding searchQueries of the tool steps */
const legacyLinesOf = (groundingData: readonly GroundingData[]): string[] => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const step of groundingData) {
        if (isSearchGroundingStep(step)) continue;
        for (const query of step.searchQueries) {
            const line = query.trim();
            if (line === '' || seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
    }
    return lines;
};

const codeInterpreterLinesOf = (agentStats: AgentStats | undefined): string[] =>
    (agentStats?.codeInterpreterSummary ?? []).flatMap((summary, index) => {
        if (!summary?.trim()) return [];
        const label = index === 0 ? 'code interpreter' : `code interpreter ${index + 1}`;
        return [`${label}: ${truncate(summary.trim())}`];
    });

export const buildToolLogDocument = (
    agentStats: AgentStats | undefined,
    groundingData: readonly GroundingData[]
): ToolLogDocument => {
    const usage = (agentStats?.toolUsage ?? []).filter((tool) => tool.name && tool.count > 0);
    const calls = agentStats?.toolCalls ?? [];
    const failedCount = usage.reduce((total, tool) => total + (tool.failed ?? 0), 0);
    const totalCalls = usage.reduce((total, tool) => total + tool.count, 0);
    return {
        mode: agentStats?.mode ?? null,
        usage,
        usageLine: usageLineOf(usage),
        codeInterpreter: codeInterpreterLinesOf(agentStats),
        calls,
        legacyLines: calls.length > 0 ? [] : legacyLinesOf(groundingData),
        callLines: calls.map(callLineOf),
        truncatedCount: agentStats?.toolCallsTruncated ?? 0,
        failedCount,
        totalCalls,
    };
};

/** Whether the block shows anything at all */
export const toolLogHasContent = (document: ToolLogDocument): boolean =>
    document.usageLine !== '' ||
    document.mode !== null ||
    document.codeInterpreter.length > 0 ||
    document.callLines.length > 0 ||
    document.legacyLines.length > 0;

/**
 * The block body in display order. A version with per-call records leads with
 * the usage line (the owner's front-row display) and puts `mode:` after it; a
 * version without them keeps today's order byte for byte.
 */
export const toolLogBodyLines = (document: ToolLogDocument): string[] => {
    const lines: string[] = [];
    const modeLine = document.mode === null ? null : `mode: ${document.mode}`;
    const hasRecords = document.calls.length > 0;
    if (hasRecords) {
        if (document.usageLine !== '') lines.push(document.usageLine);
        if (modeLine !== null) lines.push(modeLine);
        lines.push(...document.codeInterpreter);
        lines.push(...document.callLines);
        if (document.truncatedCount > 0) {
            lines.push(`…另有 ${document.truncatedCount} 次调用未记录`);
        }
        return lines;
    }
    if (modeLine !== null) lines.push(modeLine);
    if (document.usageLine !== '') lines.push(document.usageLine);
    lines.push(...document.codeInterpreter);
    lines.push(...document.legacyLines);
    return lines;
};

/** Stats of the block a folded link message replaced */
export interface ToolLogStats {
    /** Every executed call the usage line counts */
    readonly totalCalls: number;
    readonly failedCount: number;
}

export const toolLogStatsOf = (document: ToolLogDocument): ToolLogStats => ({
    totalCalls: document.totalCalls,
    failedCount: document.failedCount,
});
