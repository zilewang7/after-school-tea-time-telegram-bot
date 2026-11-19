/**
 * Tool-call records for Telegram: everything a reply did with tools, merged
 * into two collapsed blocks.
 *
 * A tool-using reply used to render one `MCPTools` + `Sources` pair per agent
 * step (plus `Agent Stats`), so a five-step answer flooded the chat with ten
 * sections and pushed the tail into a second message. The steps are merged here
 * instead: one block for the calls themselves and one for the sources,
 * deduplicated and numbered once across all steps.
 *
 * A reply that carries a per-call log (`agentStats.toolCalls`, design
 * 2026-1119-1835) shows one numbered line per executed call — what it searched,
 * read, drew or sent, and what came back — after the usage front line. A
 * version stored before that exists keeps the old merged `searchQueries` lines
 * byte for byte, so a replay of an old reply renders exactly as it did.
 *
 * The block is also measured as a whole (`toolLogPlan`): the delivery moves it
 * to its own message when it no longer fits the answer, and folds it into the
 * public log page when it cannot fit one message at all.
 *
 * Only tool steps are merged. Gemini's search grounding keeps its own
 * `GoogleSearch` block — see google-search-formatter.ts — and its steps are
 * skipped here so a reply carrying both kinds renders each in its own shape.
 *
 * Built directly as entities (bold title + expandable blockquote), so titles
 * and URLs never need escaping.
 */
import { concatMessages, splitMessage, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingCitation, GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';
import { isSearchGroundingStep } from './google-search-formatter.js';
import { TELEGRAM_MAX_ENTITIES, TELEGRAM_MAX_LENGTH } from './message-budget.js';
import {
    buildToolLogDocument,
    toolLogBodyLines,
    type ToolLogDocument,
} from './tool-log-document.js';

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
 * Legacy shape: versions stored before the per-call log
 * ------------------------------------------------------------------ */

/** A count alone reads like that many results: say how many calls failed */
const failedNote = (failed: number | undefined): string =>
    failed !== undefined && failed > 0 ? `（${failed} 次失败）` : '';

/** Summary lines of the agent run: mode, tool usage counts, code interpreter */
const agentSummaryLines = (stats?: AgentStats): string[] => {
    if (!stats) return [];

    const lines: string[] = [];

    if (stats.mode) {
        lines.push(`mode: ${stats.mode}`);
    }

    const toolUsage = (stats.toolUsage ?? [])
        .filter((tool) => tool.name && tool.count > 0)
        .map((tool) => `${tool.name} x${tool.count}${failedNote(tool.failed)}`)
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

/** Legacy call lines: the merged, deduplicated searchQueries of every tool step */
const collectLegacyToolLines = (
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

/* ------------------------------------------------------------------ *
 * Per-call log: versions that carry agentStats.toolCalls
 * ------------------------------------------------------------------ */

/** Whether this version carries the per-call log (and shows the new shape) */
const hasPerCallRecords = (agentStats: AgentStats | undefined): boolean =>
    (agentStats?.toolCalls?.length ?? 0) > 0;

/** The Tools block of one document (per-call log shape) */
const renderToolLogSection = (document: ToolLogDocument): RenderedMessage | null => {
    const lines = toolLogBodyLines(document).map((line) => plainText(line));
    return lines.length ? buildSection('Tools', joinLines(lines)) : null;
};

/** The Tools block of one version: the per-call log, or the legacy merged lines */
const renderToolsSection = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): RenderedMessage | null => {
    if (hasPerCallRecords(agentStats)) {
        return renderToolLogSection(buildToolLogDocument(agentStats, groundingData));
    }
    const lines = collectLegacyToolLines(agentStats, groundingData);
    return lines.length ? buildSection('Tools', joinLines(lines)) : null;
};

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

/**
 * The sources of one tool step, whatever shape its provider reports them in:
 * xai and mcp fill `citations`, and a step may carry grounding chunks as well.
 */
const sourcesOfStep = (metadata: GroundingData): GroundingCitation[] => [
    ...(metadata.citations ?? []),
    ...(metadata.groundingChunks ?? []).flatMap((chunk) => {
        if (chunk.web?.uri) return [{ uri: chunk.web.uri, title: chunk.web.title }];
        // An image chunk cites the page the image came from, not the CDN copy
        if (chunk.image?.sourceUri) {
            return [{ uri: chunk.image.sourceUri, title: chunk.image.title ?? chunk.image.domain }];
        }
        return [];
    }),
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

/** The Sources block: one numbered line per cited page, first-seen order */
const renderSourcesSection = (groundingData: GroundingData[]): RenderedMessage | null => {
    const citations = collectCitations(groundingData);
    if (citations.length === 0) return null;
    const sourceLines = citations.map((citation, index) =>
        concatMessages(
            `[${index + 1}] `,
            linkText(getCitationDisplayTitle(citation.uri, citation.title), citation.uri)
        )
    );
    return buildSection('Sources', joinLines(sourceLines));
};

/* ------------------------------------------------------------------ *
 * The blocks of one reply, and the fold plan of the Tools one
 * ------------------------------------------------------------------ */

/** The two blocks of one reply, kept apart so the layout can move or fold Tools */
export interface ToolRecordParts {
    /** The Tools block; null when the reply used no tool */
    readonly tools: RenderedMessage | null;
    /** The Sources block; null when no tool step cited a page */
    readonly sources: RenderedMessage | null;
    /** The Tools block's content, for the fold plan and the public log page */
    readonly document: ToolLogDocument;
}

export const buildToolRecordParts = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): ToolRecordParts => ({
    tools: renderToolsSection(agentStats, groundingData),
    sources: renderSourcesSection(groundingData),
    document: buildToolLogDocument(agentStats, groundingData),
});

/** The blocks of one reply in layout order, each an expandable blockquote */
export const buildToolRecordSections = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): RenderedMessage[] => {
    const parts = buildToolRecordParts(agentStats, groundingData);
    return [parts.tools, parts.sources].filter((section): section is RenderedMessage => section !== null);
};

/** Whether the Tools block needs at most one Telegram message, or none, or several */
export type ToolLogPlan = 'none' | 'fits' | 'overflows';

/**
 * The fold trigger (design 2026-1119-1835 §13.1): render the whole Tools block
 * and measure it with the same budgets the final split uses. `overflows` means
 * the block alone needs more than one message — exactly when the chat shows the
 * compact link message instead (or, without a page link, the old merged split).
 */
export const toolLogPlanOfDocument = (document: ToolLogDocument): ToolLogPlan => {
    const section = renderToolLogSection(document);
    if (section === null) return 'none';
    const chunks = splitMessage(section, {
        maxLength: TELEGRAM_MAX_LENGTH,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    });
    return chunks.length <= 1 ? 'fits' : 'overflows';
};

/** The plan of raw reply data; callers that already built the document use the variant above */
export const toolLogPlan = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): ToolLogPlan => toolLogPlanOfDocument(buildToolLogDocument(agentStats, groundingData));
