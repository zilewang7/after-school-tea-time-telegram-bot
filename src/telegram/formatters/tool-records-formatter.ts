/**
 * Tool-call records for Telegram: everything a reply did with tools, merged
 * into two collapsed blocks.
 *
 * A tool-using reply used to render one `MCPTools` + `Sources` pair per agent
 * step (plus `Agent Stats`), so a five-step answer flooded the chat with ten
 * sections and pushed the tail into a second message. The steps are merged here
 * instead: one block for the calls themselves — usage counts first, then one
 * line per call in call order — and one for the sources, deduplicated and
 * numbered once across all steps.
 *
 * Built directly as entities (bold title + expandable blockquote), so titles
 * and URLs never need escaping.
 */
import { concatMessages, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingCitation, GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';

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

interface Anchor {
    href: string;
    text: string;
}

const HTML_ENTITIES: Record<string, string> = {
    '&quot;': '"',
    '&#34;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
};

/** Decode the named/numeric entities Google uses in anchor text */
const decodeHtmlEntities = (text: string): string =>
    text.replace(
        /&(?:quot|#34|#39|apos|lt|gt|amp);/g,
        (entity) => HTML_ENTITIES[entity] ?? entity
    );

/** Strip HTML tags from a fragment and decode its entities */
const stripTags = (html?: string): string => {
    if (!html) return '';
    return decodeHtmlEntities(
        html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    );
};

/** Extract anchor elements from Google's `searchEntryPoint` HTML */
const extractAnchors = (content?: string): Anchor[] => {
    if (!content) return [];

    const anchorRegex = /<a[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    const matches = [...content.matchAll(anchorRegex)];

    return matches.map((match) => ({
        href: match[1] ?? '',
        text: stripTags(match[2] ?? ''),
    }));
};

/** Match search queries to anchors: exact text first, then text/href substring */
const matchQueriesToAnchors = (
    queries: string[],
    anchors: Anchor[]
): (Anchor | null)[] => {
    const used = new Set<number>();

    // Pass 1: exact text match, so short queries can't steal
    // another query's anchor via substring matching below
    const exactMatches = queries.map((query) => {
        const normQuery = query.trim().toLowerCase();
        const index = anchors.findIndex(
            (a, i) => !used.has(i) && a.text.trim().toLowerCase() === normQuery
        );
        if (index >= 0) used.add(index);
        return index;
    });

    return queries.map((query, queryIndex) => {
        const exactIndex = exactMatches[queryIndex] ?? -1;
        if (exactIndex >= 0) {
            return anchors[exactIndex] ?? null;
        }

        const normQuery = query.trim().toLowerCase();

        // Strategy 1: Match by anchor text
        const textMatch = anchors.findIndex(
            (a, i) =>
                !used.has(i) &&
                a.text &&
                (a.text.toLowerCase().includes(normQuery) ||
                    normQuery.includes(a.text.toLowerCase()))
        );

        if (textMatch >= 0) {
            used.add(textMatch);
            return anchors[textMatch] ?? null;
        }

        // Strategy 2: Match by href containing query
        const hrefMatch = anchors.findIndex((a, i) => {
            if (used.has(i)) return false;
            const href = a.href.toLowerCase();
            return (
                href.includes(normQuery) ||
                href.includes(encodeURIComponent(normQuery)) ||
                href.includes(normQuery.replace(/\s+/g, '+'))
            );
        });

        if (hrefMatch >= 0) {
            used.add(hrefMatch);
            return anchors[hrefMatch] ?? null;
        }

        // No positional fallback: a wrong link is worse than no link
        return null;
    });
};

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

/** One line per search the step ran */
const searchLines = (metadata: GroundingData): RenderedMessage[] => {
    const queries = metadata.searchQueries.filter((query) => query.trim().length > 0);
    if (!queries.length) return [];

    // MCP calls already read `tool_name: argument` (see ai/mcp/grounding.ts)
    if (metadata.provider === 'mcp') {
        return queries.map((query) => plainText(query));
    }

    // Search grounding: the query itself, linked to the search page when known
    const anchors = extractAnchors(metadata.searchEntryPoint?.renderedContent);
    const matchedAnchors = matchQueriesToAnchors(queries, anchors);

    return queries.map((query, index) => {
        const label = `google_search: ${query}`;
        const anchor = matchedAnchors[index];
        return anchor?.href ? linkText(label, anchor.href) : plainText(label);
    });
};

/** Call lines of every step, in call order, without the calls repeated verbatim */
const collectToolLines = (
    agentStats: AgentStats | undefined,
    groundingData: GroundingData[]
): RenderedMessage[] => {
    const lines: RenderedMessage[] = [
        ...agentSummaryLines(agentStats).map((line) => plainText(line)),
        ...groundingData.flatMap(searchLines),
    ];

    const seen = new Set<string>();
    return lines.filter((line) => {
        if (!line.text || seen.has(line.text)) return false;
        seen.add(line.text);
        return true;
    });
};

/**
 * Every citation of every step, first-seen order, one entry per URL: the same
 * page is read or cited by several steps and must not be listed several times.
 * A step that only knows the URL keeps the title another step found for it.
 */
const collectCitations = (groundingData: GroundingData[]): GroundingCitation[] => {
    const byUri = new Map<string, GroundingCitation>();

    for (const metadata of groundingData) {
        for (const citation of metadata.citations ?? []) {
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
 * The record blocks of one reply: at most two, each an expandable blockquote
 * that hides its content until tapped.
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
