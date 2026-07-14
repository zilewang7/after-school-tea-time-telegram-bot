/**
 * Grounding (search / citation) sections for Telegram, built directly as
 * entities: bold title + expandable blockquote of labeled links. No markdown
 * round-trip, so titles and URLs never need escaping.
 */
import { concatMessages, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';

interface Anchor {
    href: string;
    text: string;
}

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

/**
 * Strip HTML tags from string
 */
const stripTags = (html?: string): string => {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
};

/**
 * Extract anchor elements from HTML content
 */
const extractAnchors = (content?: string): Anchor[] => {
    if (!content) return [];

    const anchorRegex = /<a[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    const matches = [...content.matchAll(anchorRegex)];

    return matches.map((match) => ({
        href: match[1] ?? '',
        text: stripTags(match[2] ?? ''),
    }));
};

/**
 * Match search queries to anchors using various strategies
 */
const matchQueriesToAnchors = (
    queries: string[],
    anchors: Anchor[]
): (Anchor | null)[] => {
    const used = new Set<number>();

    return queries.map((query) => {
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

        // Strategy 3: Fallback to first unused anchor
        const fallbackMatch = anchors.findIndex((_, i) => !used.has(i));

        if (fallbackMatch >= 0) {
            used.add(fallbackMatch);
            return anchors[fallbackMatch] ?? null;
        }

        return null;
    });
};

/** `[n] title` link line */
const citationLine = (index: number, title: string, url: string): RenderedMessage =>
    concatMessages(`[${index}] `, linkText(title, url));

/** Bold title + expandable blockquote body */
const buildSection = (title: string, body: RenderedMessage): RenderedMessage =>
    concatMessages(boldText(title), '\n', wrapInBlockquote(body, true));

const buildCitationsSection = (
    title: string,
    citations: { uri: string; title?: string }[]
): RenderedMessage[] => {
    if (!citations.length) return [];

    const lines = citations.map((citation, idx) =>
        citationLine(idx + 1, getCitationDisplayTitle(citation.uri, citation.title), citation.uri)
    );
    const body = concatMessages(
        ...lines.flatMap((line, idx) => (idx > 0 ? ['\n', line] : [line]))
    );
    return [buildSection(title, body)];
};

/**
 * xai / citation-based grounding → Sources section
 */
const buildXaiGroundingSections = (metadata: GroundingData): RenderedMessage[] => {
    if (metadata.provider === 'xai' || metadata.citations?.length) {
        const citations = metadata.citations?.filter((citation) => citation.uri) ?? [];
        return buildCitationsSection('Sources', citations);
    }
    return [];
};

/**
 * Google Search grounding → GoogleSearch section (queries as links + sources)
 */
const buildSearchGroundingSection = (metadata: GroundingData): RenderedMessage[] => {
    const queries = metadata.searchQueries.filter((q) => q && q.trim().length > 0);
    if (!queries.length) return [];

    const anchors = extractAnchors(metadata.searchEntryPoint?.renderedContent);
    const matchedAnchors = matchQueriesToAnchors(queries, anchors);

    const queryParts = queries.flatMap((query, idx) => {
        const anchor = matchedAnchors[idx];
        const part = anchor?.href ? linkText(query, anchor.href) : plainText(query);
        return idx > 0 ? [' | ', part] : [part];
    });

    const chunkLines = (metadata.groundingChunks ?? []).flatMap((chunk, idx) => {
        if (!chunk.web) return [];
        const title = chunk.web.title ?? 'no title';
        const uri = chunk.web.uri ?? 'https://example.com';
        return ['\n', citationLine(idx + 1, title, uri)];
    });

    const body = concatMessages(...queryParts, ...chunkLines);
    return [buildSection('GoogleSearch', body)];
};

/**
 * MCP tool call grounding → MCPTools (+ Sources) sections
 */
const buildMcpGroundingSections = (metadata: GroundingData): RenderedMessage[] => {
    const sections: RenderedMessage[] = [];

    if (metadata.searchQueries.length > 0) {
        sections.push(
            buildSection('MCPTools', plainText(metadata.searchQueries.join(' | ')))
        );
    }

    const citations = metadata.citations?.filter((c) => c.uri) ?? [];
    sections.push(...buildCitationsSection('Sources', citations));

    return sections;
};

/**
 * Build all grounding sections for a response
 */
export const buildGroundingSections = (
    metadataList: GroundingData[]
): RenderedMessage[] => {
    if (!metadataList.length) return [];

    return metadataList.flatMap((metadata) => {
        if (metadata.provider === 'mcp') {
            return buildMcpGroundingSections(metadata);
        }

        const xaiSections = buildXaiGroundingSections(metadata);
        if (xaiSections.length) {
            return xaiSections;
        }

        return buildSearchGroundingSection(metadata);
    });
};
