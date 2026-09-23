/**
 * Tool-call records for Telegram: everything a reply did with tools, merged
 * into two collapsed blocks.
 *
 * A tool-using reply used to render one `MCPTools` + `Sources` pair per agent
 * step (plus `Agent Stats`), so a five-step answer flooded the chat with ten
 * sections and pushed the tail into a second message. The steps are merged here
 * instead: one block for the calls themselves — usage counts first, then one
 * line per call in call order — and one for the sources, deduplicated and
 * numbered once across all steps. Nothing is dropped along the way: every call
 * and every source the old sections printed is still here, only the exact
 * repeats (a call made twice, a page cited by two steps) collapse.
 *
 * Only tool steps are merged. Gemini's search grounding keeps its own
 * `GoogleSearch` block — see google-search-formatter.ts — and its steps are
 * skipped here so a reply carrying both kinds renders each in its own shape.
 *
 * Built directly as entities (bold title + expandable blockquote), so titles
 * and URLs never need escaping.
 */
import { concatMessages, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingCitation, GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';
import { isSearchGroundingStep } from './google-search-formatter.js';

/** Code-interpreter summaries are capped like before: one line, never a dump */
const SUMMARY_MAX_LENGTH = 120;

const truncate = (text: string, maxLength: number = SUMMARY_MAX_LENGTH): string =>
    text.length <= maxLength ? text : text.slice(0, maxLength - 1) + '…';

/** Bold title + expandable blockquote body */
const buildSection = (title: string, body: RenderedMessage): RenderedMessage =>
    concatMessages(boldText(title), '\n', wrapInBlockquote(body, true));

/** One rendered line per entry, joined by single line breaks */
const joinLines = (lines: RenderedMessage[]): RenderedMessage =>
    concatMessages(...lines.flatMap((line, index) => (index > 0 ? ['\n', line] : [line])));

/** Display title of a citation: the real title, else the site's hostname */
const getCitationDisplayTitle = (uri: string, title?: string): string => {
    const safeTitle = title?.trim();
    if (safeTitle && !/^\d+$/.test(safeTitle)) {
        return safeTitle;
    }

    try {
        const url = new URL(uri);
        return url.hostname.replace(/^www\./, '') || uri;
    } catch {
        return uri;
    }
};

/* ------------------------------------------------------------------ *
 * What the reply did
 * ------------------------------------------------------------------ */

/** Summary lines of the agent run: mode, tool usage counts, code interpreter */
const agentSummaryLines = (stats?: AgentStats): string[] => {
    if (!stats) return [];

    const lines: string[] = [];

    if (stats.mode) {
        lines.push(`mode: ${stats.mode}`);
    }

    const toolUsage = (stats.toolUsage ?? [])
        .filter((tool) => tool.name && tool.count > 0)
        .map((tool) => `${tool.name} x${tool.count}`)
        .join(' | ');
    if (toolUsage) {
        lines.push(`tool usage: ${toolUsage}`);
    }

    stats.codeInterpreterSummary?.forEach((summary, index) => {
        if (!summary?.trim()) return;
        const label = index === 0 ? 'code interpreter' : `code interpreter ${index + 1}`;
        lines.push(`${label}: ${truncate(summary.trim())}`);
    });

    return lines;
};

/**
 * One line per search a tool step ran. MCP calls already read
 * `tool_name: argument` (see ai/mcp/grounding.ts), so they stay verbatim.
 */
const searchLines = (metadata: GroundingData): RenderedMessage[] =>
    metadata.searchQueries
        .filter((query) => query.trim().length > 0)
        .map((query) => plainText(query));

/** Call lines of every tool step, in call order, without the calls repeated */
const collectToolLines = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): RenderedMessage[] => {
    const lines: RenderedMessage[] = [
        ...agentSummaryLines(agentStats).map((line) => plainText(line)),
        ...groundingData.filter((step) => !isSearchGroundingStep(step)).flatMap(searchLines),
    ];

    const seen = new Set<string>();
    return lines.filter((line) => {
        if (!line.text || seen.has(line.text)) return false;
        seen.add(line.text);
        return true;
    });
};

/**
 * The sources of one tool step, whatever shape its provider reports them in:
 * xai and mcp fill `citations`, and a step may carry grounding chunks as well.
 */
const sourcesOfStep = (metadata: GroundingData): GroundingCitation[] => [
    ...(metadata.citations ?? []),
    ...(metadata.groundingChunks ?? []).flatMap((chunk) =>
        chunk.web?.uri ? [{ uri: chunk.web.uri, title: chunk.web.title }] : []
    ),
];

/**
 * Every source of every tool step, first-seen order, one entry per URL: the same
 * page is read or cited by several steps and must not be listed several times.
 * A step that only knows the URL keeps the title another step found for it.
 */
const collectCitations = (groundingData: GroundingData[]): GroundingCitation[] => {
    const byUri = new Map<string, GroundingCitation>();

    for (const metadata of groundingData.filter((step) => !isSearchGroundingStep(step))) {
        for (const citation of sourcesOfStep(metadata)) {
            if (!citation.uri) continue;

            const known = byUri.get(citation.uri);
            if (!known) {
                byUri.set(citation.uri, { uri: citation.uri, title: citation.title });
            } else if (!known.title?.trim() && citation.title?.trim()) {
                known.title = citation.title;
            }
        }
    }

    return [...byUri.values()];
};

/**
 * The tool blocks of one reply: at most two, each an expandable blockquote that
 * hides its content until tapped. Gemini's search grounding is not one of them.
 */
export const buildToolRecordSections = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): RenderedMessage[] => {
    const sections: RenderedMessage[] = [];

    const toolLines = collectToolLines(agentStats, groundingData);
    if (toolLines.length) {
        sections.push(buildSection('Tools', joinLines(toolLines)));
    }

    const citations = collectCitations(groundingData);
    if (citations.length) {
        const sourceLines = citations.map((citation, index) =>
            concatMessages(
                `[${index + 1}] `,
                linkText(
                    getCitationDisplayTitle(citation.uri, citation.title),
                    citation.uri
                )
            )
        );
        sections.push(buildSection('Sources', joinLines(sourceLines)));
    }

    return sections;
};
