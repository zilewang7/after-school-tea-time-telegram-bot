/**
 * Google Search grounding result formatter for Telegram
 */
import { escapeMarkdownV2 } from './markdown-formatter';
import type { GroundingData } from '../../ai/types';

interface Anchor {
    href: string;
    text: string;
}

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
const formatSingleGrounding = (
    metadata: GroundingData,
): string => {
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
            return `[${escapeMarkdownV2(query)}](${anchor.href})`;
        }
        return escapeMarkdownV2(query);
    });

    result += formattedQueries.join(' \\| ');

    // Add grounding chunks (source citations)
    metadata.groundingChunks?.forEach((chunk, idx) => {
        if (chunk.web) {
            const title = escapeMarkdownV2(chunk.web.title ?? 'no title');
            const uri = chunk.web.uri ?? 'https://example.com';
            result += `\n>\\[${idx + 1}\\] [${title}](${uri})`;
        }
    });

    result += '||';

    return result;
};

/**
 * Format grounding metadata array for Telegram
 */
export const formatGroundingMetadata = (
    metadataList: GroundingData[]
): string => {
    if (!metadataList.length) return '';

    return metadataList
        .map((metadata) => formatSingleGrounding(metadata))
        .join('');
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
