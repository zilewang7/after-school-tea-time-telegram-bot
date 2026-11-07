import { useMemo } from 'react';
import type { ToolRecords } from '../../../api';

interface ReplyToolsPanelProps {
    tools: ToolRecords;
}

const hasRecords = (tools: ToolRecords): boolean =>
    tools.toolUsage.length > 0 ||
    tools.calls.length > 0 ||
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

    if (!hasRecords(tools)) return null;

    return (
        <>
            {tools.mode !== null && <p className="hint">模式 {tools.mode}</p>}
            {usageLine !== '' && <p className="tool-names">{usageLine}</p>}
            {tools.calls.length > 0 && (
                <ul className="list compact">
                    {tools.calls.map((call, index) => (
                        <li key={`${index}-${call}`} className="tool-call">
                            {call}
                        </li>
                    ))}
                </ul>
            )}
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
