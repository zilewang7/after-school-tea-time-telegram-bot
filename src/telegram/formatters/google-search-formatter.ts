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
 * The data itself (queries, anchors, numbered sources) lives in
 * google-search-document.ts, because the public fast page, its OG card and the
 * folded link message all read the same document. This module only keeps the
 * rendered-message shape the chat builders ask for.
 */
import type { RenderedMessage } from 'telegram-md-entities';
import type { GroundingData } from '../../ai/types.js';
import {
    buildGoogleSearchDocument,
    renderGoogleSearchSection,
    type GoogleSearchBlockDocument,
} from './google-search-document.js';

/**
 * Search grounding rather than a tool call: no citations, and from neither mcp
 * nor xai — the dispatch the merged blocks replaced, kept so a reply that
 * carries both kinds still lands in the right renderer. Defined with the
 * document; re-exported here for the renderers that already import this module.
 */
export { isSearchGroundingStep } from './google-search-document.js';

export interface GoogleSearchBlock {
    message: RenderedMessage;
    /** First query rendered with a link; used for the message-level preview */
    firstQueryUrl?: string;
}

/** The chat form of one documented block: bold title + expandable blockquote */
const chatBlockOf = (block: GoogleSearchBlockDocument): GoogleSearchBlock => ({
    message: renderGoogleSearchSection(block),
    ...(block.firstQueryUrl === undefined ? {} : { firstQueryUrl: block.firstQueryUrl }),
});

/** One `GoogleSearch` block per search-grounding step, in step order */
export const buildGoogleSearchBlocks = (
    groundingData: GroundingData[]
): GoogleSearchBlock[] => buildGoogleSearchDocument(groundingData).blocks.map(chatBlockOf);

/** Rendered messages, for callers that do not need the preview metadata */
export const buildGoogleSearchSections = (
    groundingData: GroundingData[]
): RenderedMessage[] => buildGoogleSearchBlocks(groundingData).map((block) => block.message);
