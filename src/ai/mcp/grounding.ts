/**
 * Extract grounding data (search queries + citations) from MCP tool results
 */
import type { GroundingData } from '../types.js';

export const extractGroundingFromToolResult = (
    toolName: string,
    argsJson: string,
    resultContent: string
): GroundingData | null => {
    // Extract search query from tool arguments
    let searchQuery = '';
    try {
        const args = JSON.parse(argsJson);
        searchQuery = args.query || args.question || args.search || args.url || '';
    } catch {
        // ignore
    }

    // Extract URLs from result content
    const urlRegex = /https?:\/\/[^\s)"\]>]+/g;
    const urls = resultContent.match(urlRegex) ?? [];

    // Extract titles (markdown links)
    const titleRegex = /\[([^\]]+)\]\(https?:\/\/[^)]+\)/g;
    const titles: string[] = [];
    let match;
    while ((match = titleRegex.exec(resultContent)) !== null) {
        titles.push(match[1] ?? '');
    }

    if (!searchQuery && urls.length === 0) return null;

    const citations = urls.slice(0, 10).map((uri, idx) => ({
        uri,
        title: titles[idx] || undefined,
    }));

    return {
        provider: 'mcp',
        searchQueries: searchQuery ? [`${toolName}: ${searchQuery}`] : [toolName],
        citations,
    };
};
