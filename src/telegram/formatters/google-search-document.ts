/**
 * The GoogleSearch footer as data (design 2026-1113-1831 §4.2).
 *
 * One document per reply, shared by the chat footer, the public fast page and
 * the page's OG card: which queries were put to Google (and which search page
 * each links to), which numbered sources back the answer, and the plain text
 * the quote block holds. Built without Telegram entities so the panel can
 * render HTML with exactly the content the chat shows.
 *
 * The footer also answers whether it fits one Telegram message at all
 * (`googleSearchFooterPlan`): that is the trigger of the folded link message.
 */
import { concatMessages, splitMessage, wrapInBlockquote } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { GroundingData } from '../../ai/types.js';
import { boldText, linkText, plainText } from './entity-text.js';
import { resolveGroundingSources } from './grounding-sources.js';
import { TELEGRAM_MAX_ENTITIES, TELEGRAM_MAX_LENGTH } from './message-budget.js';

/** One query rendered in the footer, with the search page Google linked it to */
export interface GoogleSearchQuery {
    readonly text: string;
    readonly href?: string;
}

/** One numbered source line of the footer */
export interface GoogleSearchSource {
    readonly number: number;
    readonly title: string;
    readonly uri: string;
}

/** What one search-grounding step shows */
export interface GoogleSearchBlockDocument {
    readonly queries: readonly GoogleSearchQuery[];
    readonly sources: readonly GoogleSearchSource[];
    /** First query link of this step (http(s) only); the inline layout's preview card */
    readonly firstQueryUrl?: string;
}

/** Everything the GoogleSearch footer of one reply shows */
export interface GoogleSearchDocument {
    /** One entry per search-grounding step that has something to show, in step order */
    readonly blocks: readonly GoogleSearchBlockDocument[];
    /** Queries the footer lists, across blocks */
    readonly queryCount: number;
    /** Numbered sources the footer lists, across blocks */
    readonly sourceCount: number;
    /** The plain text the quote block holds (titles excluded), across blocks */
    readonly bodyText: string;
    /** First query link of the whole footer (http(s) only) */
    readonly firstQueryUrl?: string;
}

/**
 * Search grounding rather than a tool call: no citations, and from neither mcp
 * nor xai — the dispatch the merged blocks replaced, kept so a reply that
 * carries both kinds still lands in the right renderer.
 */
export const isSearchGroundingStep = (metadata: GroundingData): boolean =>
    metadata.provider !== 'mcp' && metadata.provider !== 'xai' && !(metadata.citations ?? []).length;

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
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
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
const matchQueriesToAnchors = (queries: string[], anchors: Anchor[]): (Anchor | null)[] => {
    const used = new Set<number>();

    // Pass 1: exact text match, so short queries can't steal
    // another query's anchor via substring matching below
    const exactMatches = queries.map((query) => {
        const normQuery = query.trim().toLowerCase();
        const index = anchors.findIndex(
            (anchor, index_) => !used.has(index_) && anchor.text.trim().toLowerCase() === normQuery
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
            (anchor, index_) =>
                !used.has(index_) &&
                anchor.text !== '' &&
                (anchor.text.toLowerCase().includes(normQuery) ||
                    normQuery.includes(anchor.text.toLowerCase()))
        );

        if (textMatch >= 0) {
            used.add(textMatch);
            return anchors[textMatch] ?? null;
        }

        // Strategy 2: Match by href containing query
        const hrefMatch = anchors.findIndex((anchor, index_) => {
            if (used.has(index_)) return false;
            const href = anchor.href.toLowerCase();
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

/** Only real web links are usable as a Telegram link preview */
const HTTP_URL_PATTERN = /^https?:\/\//i;

const blockDocumentOf = (metadata: GroundingData): GoogleSearchBlockDocument | null => {
    const queries = metadata.searchQueries.filter((query) => query && query.trim().length > 0);
    const anchors = extractAnchors(metadata.searchEntryPoint?.renderedContent);
    const matchedAnchors = matchQueriesToAnchors(queries, anchors);
    const sources = resolveGroundingSources(metadata).sources.map((source) => ({
        number: source.number,
        title: source.title,
        uri: source.uri,
    }));

    const queryDocuments: GoogleSearchQuery[] = queries.map((query, index) => {
        const href = matchedAnchors[index]?.href;
        return href === undefined ? { text: query } : { text: query, href };
    });

    if (queryDocuments.length === 0 && sources.length === 0) return null;

    const firstQueryUrl = queryDocuments
        .map((query) => query.href)
        .find((href): href is string => href !== undefined && HTTP_URL_PATTERN.test(href));

    return {
        queries: queryDocuments,
        sources,
        ...(firstQueryUrl === undefined ? {} : { firstQueryUrl }),
    };
};

/** The body text of one block as the chat quote block holds it: queries, then sources */
const blockBodyTextOf = (block: GoogleSearchBlockDocument): string => {
    const queryText = block.queries.map((query) => query.text).join(' | ');
    const sourceLines = block.sources.map((source) => `[${source.number}] ${source.title}`);
    return [queryText, ...sourceLines].filter((line) => line !== '').join('\n');
};

/** One `GoogleSearch` block per search-grounding step, in step order */
export const buildGoogleSearchDocument = (
    groundingData: readonly GroundingData[]
): GoogleSearchDocument => {
    const blocks = groundingData
        .filter(isSearchGroundingStep)
        .map(blockDocumentOf)
        .filter((block): block is GoogleSearchBlockDocument => block !== null);

    const firstQueryUrl = blocks
        .map((block) => block.firstQueryUrl)
        .find((url): url is string => url !== undefined);

    return {
        blocks,
        queryCount: blocks.reduce((total, block) => total + block.queries.length, 0),
        sourceCount: blocks.reduce((total, block) => total + block.sources.length, 0),
        bodyText: blocks.map(blockBodyTextOf).join('\n'),
        ...(firstQueryUrl === undefined ? {} : { firstQueryUrl }),
    };
};

/** `[n] title` link line */
const citationLine = (number: number, title: string, uri: string): RenderedMessage =>
    concatMessages(`[${number}] `, linkText(title, uri));

/** Queries joined by ` | `, then one numbered line per source */
const renderBlockBody = (block: GoogleSearchBlockDocument): RenderedMessage => {
    const parts: RenderedMessage[] = [];
    block.queries.forEach((query, index) => {
        if (index > 0) parts.push(plainText(' | '));
        parts.push(query.href === undefined ? plainText(query.text) : linkText(query.text, query.href));
    });
    block.sources.forEach((source, index) => {
        // Only the first row needs the line break that separates it from the query
        const separator = index > 0 || block.queries.length > 0 ? '\n' : '';
        if (separator !== '') parts.push(plainText(separator));
        parts.push(citationLine(source.number, source.title, source.uri));
    });
    return concatMessages(...parts);
};

/** Bold title + expandable blockquote body */
export const renderGoogleSearchSection = (block: GoogleSearchBlockDocument): RenderedMessage =>
    concatMessages(boldText('GoogleSearch'), '\n', wrapInBlockquote(renderBlockBody(block), true));

/** Every footer section of one reply, in step order, separated by one line break */
export const renderGoogleSearchFooter = (document: GoogleSearchDocument): RenderedMessage =>
    concatMessages(
        ...document.blocks.flatMap((block, index) => {
            const section = renderGoogleSearchSection(block);
            return index > 0 ? ['\n', section] : [section];
        })
    );

/** Whether the footer needs at most one Telegram message, or none, or several */
export type GoogleSearchFooterPlan = 'none' | 'fits' | 'overflows';

/**
 * The fold trigger (design §3.1): render the whole footer — every search step's
 * title and quote block — and measure it with the same three budgets the final
 * split uses. `overflows` means the footer alone needs more than one message,
 * which is exactly when the chat shows the compact link message instead.
 */
export const googleSearchFooterPlanOfDocument = (
    document: GoogleSearchDocument
): GoogleSearchFooterPlan => {
    if (document.blocks.length === 0) return 'none';
    const footer = renderGoogleSearchFooter(document);
    const chunks = splitMessage(footer, {
        maxLength: TELEGRAM_MAX_LENGTH,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    });
    return chunks.length <= 1 ? 'fits' : 'overflows';
};

/** The plan of raw grounding data; callers that already built the document use the variant above */
export const googleSearchFooterPlan = (
    groundingData: readonly GroundingData[]
): GoogleSearchFooterPlan => googleSearchFooterPlanOfDocument(buildGoogleSearchDocument(groundingData));
