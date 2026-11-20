/**
 * Result helpers of the workspace tools: a plain text result, or an error the
 * model can act on (the same shape the media tools use). The multi-file calls
 * also share their reporting helpers: the two short trace strings, one named
 * line per failed item, and one log line per batch.
 */
import type { ToolCallTrace, ToolResult } from '../../ai/tools/tool-types.js';
import { traceText } from './tool-trace.js';

export const workspaceToolError = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
});

export const workspaceToolSuccess = (
    content: string,
    modelImages: ToolResult['modelImages'] = [],
    trace?: ToolCallTrace
): ToolResult => ({
    content,
    isError: false,
    images: [],
    ...(modelImages.length > 0 ? { modelImages } : {}),
    record: null,
    ...(trace === undefined ? {} : { trace }),
});

/** How many labels a trace shows before it counts the rest */
const TRACE_LABELS_SHOWN = 3;

/** `3 个文件：notes/a.md,src/b.ts,widgets/c.html` — the display trace of a batch call */
export const workspaceBatchTraceArgument = (noun: string, labels: readonly string[]): string => {
    const shown = labels
        .slice(0, TRACE_LABELS_SHOWN)
        .map((label) => traceText(label))
        .join(',');
    return labels.length > TRACE_LABELS_SHOWN
        ? `${labels.length} ${noun}：${shown}…`
        : `${labels.length} ${noun}：${shown}`;
};

/** A failed item names its path, unless the sentence already says which file it is */
export const workspaceBatchFailureLine = (label: string, error: string): string =>
    error.includes(`《${label}》`) ? error : `《${label}》：${error}`;

/** One warn line per batch with failed items; a parameter error goes through `reject` instead */
const BATCH_LOG_MAX_CHARS = 200;

export const logWorkspaceBatchFailures = (toolName: string, failures: readonly string[]): void => {
    if (failures.length === 0) return;
    const text = Array.from(failures.map(traceText).join('；'))
        .slice(0, BATCH_LOG_MAX_CHARS)
        .join('');
    console.warn(`[${toolName}] ${failures.length} 项没成功：${text}`);
};
