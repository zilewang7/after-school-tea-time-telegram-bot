/**
 * Gemini's search grounding, kept in the dedicated form it had before the tool
 * records were merged: its own `GoogleSearch` block, the queries linked to the
 * search page Google rendered for them, and one numbered line per grounded
 * source.
 *
 * Only this shape keeps that rendering — mcp and xai steps go through the merged
 * `Tools` / `Sources` blocks (see tool-records-formatter.ts), which is where the
 * per-step blocks used to flood the chat.
 *
 * Built directly as entities (bold title + expandable blockquote), so titles
 * and URLs never need escaping.
 */
import { concatMessages, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';

interface Anchor {
    href: string;
    text: string;
}

/** Bold title + expandable blockquote body */
const buildSection = (title: string, body: RenderedMessage): RenderedMessage =>
    concatMessages(boldText(title), '\n', wrapInBlockquote(body, true));

/** `[n] title` link line */
const citationLine = (index: number, title: string, url: string): RenderedMessage =>
    concatMessages(`[${index}] `, linkText(title, url));

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

/**
 * Search grounding rather than a tool call: no citations, and from neither mcp
 * nor xai — the dispatch the merged blocks replaced, kept so a reply that
 * carries both kinds still lands in the right renderer.
 */
export const isSearchGroundingStep = (metadata: GroundingData): boolean =>
    metadata.provider !== 'mcp' &&
    metadata.provider !== 'xai' &&
    !(metadata.citations ?? []).length;

const buildGoogleSearchSection = (metadata: GroundingData): RenderedMessage[] => {
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

/** One `GoogleSearch` block per search-grounding step, in step order */
export const buildGoogleSearchSections = (
    groundingData: GroundingData[]
): RenderedMessage[] => groundingData.filter(isSearchGroundingStep).flatMap(buildGoogleSearchSection);
