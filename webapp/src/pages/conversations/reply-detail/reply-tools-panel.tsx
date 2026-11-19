import { useMemo } from 'react';
import type { ToolCallView, ToolRecords } from '../../../api';

interface ReplyToolsPanelProps {
    tools: ToolRecords;
}

/** A call at least this slow shows its duration, as the Telegram block does */
const SLOW_CALL_MS = 3000;

/** `3.4s` for a slow call's duration; one decimal, never `0.0s` */
const formatCallSeconds = (ms: number): string => `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;

/** One log row: `1. name: argument → result`; a failed call says so, a slow one ends with its seconds */
const callLineOf = (call: ToolCallView, index: number): string => {
    let line = `${index + 1}. ${call.name}`;
    if (call.argument !== null && call.argument !== '') line += `: ${call.argument}`;
    if (call.failed) {
        line += call.result === null || call.result === '' ? ' → 失败' : ` → 失败：${call.result}`;
    } else if (call.result !== null && call.result !== '') {
        line += ` → ${call.result}`;
    }
    if (call.ms !== null && call.ms >= SLOW_CALL_MS) line += ` · ${formatCallSeconds(call.ms)}`;
    return line;
};

interface CallRow {
    key: string;
    line: string;
    failed: boolean;
}

const callRowsOf = (calls: readonly ToolCallView[]): CallRow[] =>
    calls.map((call, index) => ({ key: `${index}-${call.name}`, line: callLineOf(call, index), failed: call.failed }));

const hasRecords = (tools: ToolRecords): boolean =>
    tools.toolUsage.length > 0 ||
    tools.calls.length > 0 ||
    tools.callLog.length > 0 ||
    tools.toolCallsTruncated > 0 ||
    tools.sources.length > 0 ||
    tools.searches.length > 0 ||
    tools.codeInterpreter.length > 0;

/** A version's tool and search records, already merged by the server */
export const ReplyToolsPanel = ({ tools }: ReplyToolsPanelProps) => {
    const usageLine = useMemo(
        () =>
            tools.toolUsage
                .map((tool) => `${tool.name} ×${tool.count}${tool.failed > 0 ? `（${tool.failed} 次失败）` : ''}`)
                .join(' · '),
        [tools.toolUsage]
    );
    // Versions stored after the per-call log existed list every call; older ones keep the merged lines
    const callRows = useMemo(() => callRowsOf(tools.callLog), [tools.callLog]);

    if (!hasRecords(tools)) return null;

    return (
        <>
            {tools.mode !== null && <p className="hint">模式 {tools.mode}</p>}
            {usageLine !== '' && <p className="tool-names">{usageLine}</p>}
            {callRows.length > 0 && (
                <ol className="list compact">
                    {callRows.map((row) => (
                        <li key={row.key} className={row.failed ? 'tool-call tool-call-failed' : 'tool-call'}>
                            {row.line}
                        </li>
                    ))}
                </ol>
            )}
            {callRows.length === 0 && tools.calls.length > 0 && (
                <ul className="list compact">
                    {tools.calls.map((call, index) => (
                        <li key={`${index}-${call}`} className="tool-call">
                            {call}
                        </li>
                    ))}
                </ul>
            )}
            {tools.toolCallsTruncated > 0 && <p className="hint">…另有 {tools.toolCallsTruncated} 次调用未记录</p>}
            {tools.searches.map((search, index) => (
                <div key={`search-${index}`} className="search-block">
                    {search.queries.length > 0 && <p className="hint">搜索：{search.queries.join(' | ')}</p>}
                    {search.imageQueries.length > 0 && (
                        <p className="hint">图片搜索：{search.imageQueries.join(' | ')}</p>
                    )}
                    {search.sources.length > 0 && (
                        <ul className="list compact">
                            {search.sources.map((source) => (
                                <li key={source.uri}>
                                    <a href={source.uri} target="_blank" rel="noreferrer">
                                        {source.title ?? source.uri}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ))}
            {tools.sources.length > 0 && (
                <ul className="list compact">
                    {tools.sources.map((source) => (
                        <li key={source.uri}>
                            <a href={source.uri} target="_blank" rel="noreferrer">
                                {source.title ?? source.uri}
                            </a>
                        </li>
                    ))}
                </ul>
            )}
            {tools.codeInterpreter.map((line, index) => (
                <p key={`code-${index}`} className="prewrap hint">
                    {line}
                </p>
            ))}
        </>
    );
};
