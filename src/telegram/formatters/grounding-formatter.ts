/**
 * Google Search grounding result formatter for Telegram
 */
import { escapeMarkdownV2 } from './markdown-formatter.js';
import { getTelegramVisibleLength, TELEGRAM_MAX_LENGTH } from './smart-splitter.js';
import type { GroundingData } from '../../ai/types.js';

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
 * Escape characters in URLs for Telegram MarkdownV2 links.
 * Per Telegram Bot API: inside [text](url) links, only ')' and '\' need escaping.
 * We URL-encode ')' to avoid breaking the link syntax.
 */
const escapeUrlForTelegram = (url: string): string => {
    return url.replace(/\\/g, '%5C').replace(/\)/g, '%29');
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

/**
 * Format single grounding metadata entry
 */
const formatXaiGroundingSections = (metadata: GroundingData): string[] => {
    if (metadata.provider === 'xai' || metadata.citations?.length) {
        const citations = metadata.citations?.filter((citation) => citation.uri) ?? [];
        if (!citations.length) return [];

        const sections: string[] = [];
        let currentEntries = '';

        citations.forEach((citation, idx) => {
            const title = escapeMarkdownV2(
                getCitationDisplayTitle(citation.uri, citation.title)
            );
            const safeUrl = escapeUrlForTelegram(citation.uri);
            const entry = `${currentEntries ? '\n>' : ''}\\[${idx + 1}\\] [${title}](${safeUrl})`;
            const nextEntries = currentEntries + entry;
            const nextSection = `\n*Sources*\n**>${nextEntries}||`;

            if (
                currentEntries &&
                getTelegramVisibleLength(nextSection) > TELEGRAM_MAX_LENGTH
            ) {
                sections.push(`\n*Sources*\n**>${currentEntries}||`);
                currentEntries = `\\[${idx + 1}\\] [${title}](${safeUrl})`;
                return;
            }

            currentEntries = nextEntries;
        });

        if (currentEntries) {
            sections.push(`\n*Sources*\n**>${currentEntries}||`);
        }

        return sections;
    }

    return [];
};

const formatSingleGrounding = (
    metadata: GroundingData,
): string => {
    const xaiSections = formatXaiGroundingSections(metadata);
    if (xaiSections.length) {
        return xaiSections.join('');
    }

    const queries = metadata.searchQueries.filter(
        (q) => q && q.trim().length > 0
    );

    if (!queries.length) return '';

    let result = '\n*GoogleSearch*\n**>';

    const anchors = extractAnchors(metadata.searchEntryPoint?.renderedContent);
    const matchedAnchors = matchQueriesToAnchors(queries, anchors);

    // Format queries with links
    const formattedQueries = queries.map((query, idx) => {
        const anchor = matchedAnchors[idx];
        if (anchor?.href) {
            return `[${escapeMarkdownV2(query)}](${escapeUrlForTelegram(anchor.href)})`;
        }
        return escapeMarkdownV2(query);
    });

    result += formattedQueries.join(' \\| ');

    // Add grounding chunks (source citations)
    metadata.groundingChunks?.forEach((chunk, idx) => {
        if (chunk.web) {
            const title = escapeMarkdownV2(chunk.web.title ?? 'no title');
            const uri = chunk.web.uri ?? 'https://example.com';
            result += `\n>\\[${idx + 1}\\] [${title}](${escapeUrlForTelegram(uri)})`;
        }
    });

    result += '||';

    return result;
};

/**
 * Format MCP tool call grounding data
 */
const formatMcpGrounding = (metadata: GroundingData): string => {
    const sections: string[] = [];

    // Show search queries (tool names + keywords)
    if (metadata.searchQueries.length > 0) {
        const queries = metadata.searchQueries.map(q => escapeMarkdownV2(q)).join(' \\| ');
        sections.push(`\n*MCPTools*\n**>${queries}||`);
    }

    // Show citation URLs
    const citations = metadata.citations?.filter(c => c.uri) ?? [];
    if (citations.length > 0) {
        let entries = '';
        citations.forEach((citation, idx) => {
            const title = escapeMarkdownV2(
                getCitationDisplayTitle(citation.uri, citation.title)
            );
            const safeUrl = escapeUrlForTelegram(citation.uri);
            const entry = `${entries ? '\n>' : ''}\\[${idx + 1}\\] [${title}](${safeUrl})`;
            entries += entry;
        });
        sections.push(`\n*Sources*\n**>${entries}||`);
    }

    return sections.join('');
};

/**
 * Format grounding metadata array for Telegram
 */
export const formatGroundingMetadata = (
    metadataList: GroundingData[]
): string => {
    if (!metadataList.length) return '';

    return formatGroundingSections(metadataList).join('');
};

export const formatGroundingSections = (
    metadataList: GroundingData[]
): string[] => {
    if (!metadataList.length) return [];

    return metadataList.flatMap((metadata) => {
        if (metadata.provider === 'mcp') {
            const section = formatMcpGrounding(metadata);
            return section ? [section] : [];
        }

        const xaiSections = formatXaiGroundingSections(metadata);
        if (xaiSections.length) {
            return xaiSections;
        }

        const section = formatSingleGrounding(metadata);
        return section ? [section] : [];
    });
};

/**
 * Append grounding metadata to existing message
 */
export const appendGroundingToMessage = (
    message: string,
    metadataList: GroundingData[]
): string => {
    if (!message || !metadataList.length) return message;

    const groundingSection = formatGroundingMetadata(metadataList);
    return message + groundingSection;
};
