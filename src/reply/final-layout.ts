/**
 * The final layout of one reply: the chunks `buildFinalMessages` renders, plus
 * the decision whether a split reply keeps its chain of thought inline (a
 * collapsed quote on the first message) or hands it to the long-CoT link
 * message, and whether an overflowing GoogleSearch footer becomes one compact
 * link message at the end.
 *
 * The final delivery and the stored-version refresh build their layout here, so
 * the chat a live reply ends with matches what a version replay shows.
 */
import { buildFinalMessages, type FinalMessageChunk } from '../telegram/formatters/final-message-builder.js';
import type { GoogleSearchDocument } from '../telegram/formatters/google-search-document.js';
import { STREAMING_MAX_LENGTH } from '../telegram/formatters/message-budget.js';
import { renderThinkingQuote } from '../telegram/formatters/quoted-render.js';
import type { ContextLinkResolver } from '../telegram/formatters/context-links.js';
import type { ThinkingLinkRef } from '../telegram/formatters/thinking-link.js';
import type { SearchPageLink } from '../shared/search-page.js';
import type { AgentStats, GroundingData } from '../ai/types.js';

/**
 * A CoT that renders to half a streaming message already pushes the answer out
 * of the first message: a reply that has to split then shows the thinking as
 * the link message instead of keeping a half-message quote inline.
 */
export const LINK_COT_LENGTH = STREAMING_MAX_LENGTH / 2;

export interface FinalLayoutInput {
    readonly text: string;
    readonly thinking: string;
    /** Long-CoT link message: leads the layout and replaces the CoT quote */
    readonly thinkingLink?: ThinkingLinkRef;
    /**
     * Folded GoogleSearch footer: one compact link message ends the reply.
     * Passing it always folds; the version replay keys the fold off its token.
     */
    readonly searchLink?: SearchPageLink;
    /** Prebuilt footer document, so a large grounding payload is parsed once */
    readonly googleSearch?: GoogleSearchDocument;
    readonly agentStats?: AgentStats;
    readonly groundingData?: GroundingData[];
    readonly wasStoppedByUser?: boolean;
    readonly resolveContextLink?: ContextLinkResolver;
}

/** The reply's final chunks (the same function the version replay uses) */
export const buildFinalChunks = (input: FinalLayoutInput): FinalMessageChunk[] =>
    buildFinalMessages({
        text: input.text,
        thinking: input.thinking,
        thinkingLink: input.thinkingLink,
        searchLink: input.searchLink,
        googleSearch: input.googleSearch,
        agentStats: input.agentStats,
        groundingData: input.groundingData,
        wasStoppedByUser: input.wasStoppedByUser,
        resolveContextLink: input.resolveContextLink,
    });

/** How long the inline CoT quote renders, in message characters */
export const renderedCoTLength = (thinking: string): number =>
    thinking.trim() === '' ? 0 : renderThinkingQuote(thinking, { expandable: true }).text.length;

/** Whether a split reply shows its CoT as the link message instead of a quote */
export const shouldLinkCoT = (input: {
    readonly renderedThinking: number;
    readonly chunkCount: number;
}): boolean => input.chunkCount > 1 && input.renderedThinking >= LINK_COT_LENGTH;
