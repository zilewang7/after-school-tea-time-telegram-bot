import { useMemo } from 'react';
import type { ToolCallLinkView, ToolCallView, ToolRecords } from '../../../api';

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

/** A piece of a log line: linked (`url` set) or plain */
interface LineSegment {
    text: string;
    url: string | null;
}

/**
 * Cut the line at its clickable spans: the same `h45` refs the Telegram block
 * links, so the panel and the chat open the same message.
 */
const segmentsOf = (line: string, links: readonly ToolCallLinkView[]): LineSegment[] => {
    const spans: { offset: number; length: number; url: string }[] = [];
    for (const link of links) {
        if (link.text === '') continue;
        for (let at = line.indexOf(link.text); at >= 0; at = line.indexOf(link.text, at + link.text.length)) {
            if (spans.some((span) => at < span.offset + span.length && span.offset < at + link.text.length)) continue;
            spans.push({ offset: at, length: link.text.length, url: link.url });
        }
    }
    if (spans.length === 0) return [{ text: line, url: null }];
    spans.sort((left, right) => left.offset - right.offset);
    const segments: LineSegment[] = [];
    let cursor = 0;
    for (const span of spans) {
        if (span.offset > cursor) segments.push({ text: line.slice(cursor, span.offset), url: null });
        segments.push({ text: line.slice(span.offset, span.offset + span.length), url: span.url });
        cursor = span.offset + span.length;
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor), url: null });
    return segments;
};

interface CallRow {
    key: string;
    segments: LineSegment[];
    failed: boolean;
}

const callRowsOf = (calls: readonly ToolCallView[]): CallRow[] =>
    calls.map((call, index) => ({
        key: `${index}-${call.name}`,
        segments: segmentsOf(callLineOf(call, index), call.links),
        failed: call.failed,
    }));

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
                            {row.segments.map((segment, index) =>
                                segment.url === null ? (
                                    <span key={`${row.key}-${index}`}>{segment.text}</span>
                                ) : (
                                    <a key={`${row.key}-${index}`} href={segment.url} target="_blank" rel="noreferrer">
                                        {segment.text}
                                    </a>
                                )
                            )}
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
