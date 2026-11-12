/**
 * Final response assembly: collapsed thinking quote + markdown-rendered text
 * + tool-call / sources sections, composed as one entity message and then
 * split into chunks that fit the length, entity and entity-URL budgets.
 * Formatting spanning a boundary is closed and reopened by the splitter, so
 * styles are seamless across messages.
 */
import { concatMessages, renderMarkdown, splitMessage } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { getRenderConfig } from '../../config/render-config.js';
import { stripPerQueryResultCitations } from '../../shared/citation-markers.js';
import { buildToolRecordSections } from './tool-records-formatter.js';
import { buildGoogleSearchBlocks, isSearchGroundingStep } from './google-search-formatter.js';
import type { GoogleSearchBlock } from './google-search-formatter.js';
import type { LinkPreviewOptions } from '../link-preview.js';
import { disabledLinkPreview } from '../link-preview.js';
import { resolveGroundingSources } from './grounding-sources.js';
import { inlineCitations } from './inline-citations.js';
import { plainText } from './entity-text.js';
import { renderThinkingQuote } from './quoted-render.js';
import { linkifyContextNumbers, type ContextLinkResolver } from './context-links.js';
import { TELEGRAM_MAX_ENTITIES, TELEGRAM_MAX_LENGTH } from './message-budget.js';
import {
    toThinkingLinkChunk,
    thinkingLinkSummaryOf,
    type ThinkingLinkRef,
} from './thinking-link.js';

/**
 * Display-only superscript markers: the stored reply text stays clean, so a
 * rerender (edit/retry) and the next turn's context never see them. Raw
 * PerQueryResult markers are dropped after the superscripts are placed, so a
 * version stored before the cleanup does not show them when it is replayed and
 * a support whose segment text carries a marker still finds its segment.
 */
const withCitations = (text: string, grounding: GroundingData | undefined): string => {
    if (grounding === undefined || !getRenderConfig().groundingCitations) {
        return stripPerQueryResultCitations(text);
    }
    const cited = inlineCitations(
        text,
        resolveGroundingSources(grounding),
        grounding.groundingSupports
    );
    return stripPerQueryResultCitations(cited);
};

export interface FinalMessageBuildOptions {
    text: string;
    thinking?: string;
    /**
     * Long-CoT link message: leads the reply and replaces the thinking quote.
     * The streaming phase may have emitted it already, in which case the caller
     * drops the first chunk.
     */
    thinkingLink?: ThinkingLinkRef;
    groundingData?: GroundingData[];
    agentStats?: AgentStats;
    wasStoppedByUser?: boolean;
    maxLength?: number;
    /** Makes the `#N` context references clickable (display-only) */
    resolveContextLink?: ContextLinkResolver;
}

export interface FinalMessageChunk extends RenderedMessage {
    /**
     * Preview behavior for this message. Undefined keeps Telegram's default;
     * `{ is_disabled: true }` suppresses it; `{ url }` pins one link.
     */
    linkPreviewOptions?: LinkPreviewOptions;
}

/**
 * One preview per reply. A search footer can span several messages: the card
 * for its first linked query rides on the chunk that starts it. Without a
 * linked query, only the last chunk keeps Telegram's default. Every other
 * chunk disables its preview so one reply cannot produce several cards.
 */
const applyLinkPreviewPolicy = (
    chunks: RenderedMessage[],
    searchBlocks: readonly GoogleSearchBlock[]
): FinalMessageChunk[] => {
    if (chunks.length === 0) return [];

    const previewUrl = searchBlocks
        .map((block) => block.firstQueryUrl)
        .find((url): url is string => url !== undefined);

    if (previewUrl !== undefined) {
        const previewIndex = chunks.findIndex((chunk) =>
            chunk.entities.some((entity) => entity.url === previewUrl)
        );

        if (previewIndex >= 0) {
            return chunks.map((chunk, index): FinalMessageChunk =>
                index === previewIndex
                    ? { ...chunk, linkPreviewOptions: { url: previewUrl } }
                    : { ...chunk, linkPreviewOptions: disabledLinkPreview }
            );
        }
    }

    return chunks.map((chunk, index): FinalMessageChunk =>
        index === chunks.length - 1
            ? chunk
            : { ...chunk, linkPreviewOptions: disabledLinkPreview }
    );
};

export const buildFinalMessages = (
    options: FinalMessageBuildOptions
): FinalMessageChunk[] => {
    const bodyChunks = buildBodyChunks(options);
    // The link message leads the reply. It never goes through the split: it is
    // one fixed link plus the italic stats of the CoT it hides, and its own
    // preview card must survive the body's policy.
    const summary =
        options.thinkingLink === undefined || options.thinking === undefined
            ? undefined
            : thinkingLinkSummaryOf(options.thinking) ?? undefined;
    return options.thinkingLink
        ? [toThinkingLinkChunk(options.thinkingLink, summary), ...bodyChunks]
        : bodyChunks;
};

/**
 * Whether the inline CoT quote got cut by the split: its blockquote leads the
 * first chunk, so a shorter blockquote there is its cut head — the rest of the
 * CoT would reopen as a quote on a later message.
 */
const quoteSplitAcrossChunks = (
    quote: RenderedMessage,
    chunks: readonly RenderedMessage[]
): boolean => {
    const first = chunks[0];
    if (first === undefined) return false;
    const leading = first.entities.find(
        (entity) => entity.offset === 0 && entity.type === 'expandable_blockquote'
    );
    return leading === undefined || leading.length < quote.text.length;
};

/**
 * The layout that keeps the whole CoT quote on the first message: the body is
 * split with the full budget, then the first body chunk is cut down to what the
 * quote leaves. Only used when the regular split would cut the quote itself (a
 * body without paragraph breaks makes the splitter fall back to the quote's
 * last paragraph boundary).
 */
const splitAfterQuote = (
    quote: RenderedMessage,
    body: RenderedMessage,
    maxLength: number
): RenderedMessage[] => {
    const remainingLength = maxLength - quote.text.length - 1;
    const remainingEntities = TELEGRAM_MAX_ENTITIES - quote.entities.length;
    const bodyChunks = body.text
        ? splitMessage(body, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES })
        : [];
    if (remainingLength < 1 || remainingEntities < 1 || bodyChunks.length === 0) {
        return [quote, ...bodyChunks];
    }
    const firstBody = bodyChunks[0];
    const pieces =
        firstBody === undefined
            ? []
            : splitMessage(firstBody, {
                  maxLength: remainingLength,
                  maxEntities: remainingEntities,
              });
    const firstPiece = pieces[0];
    const chunks =
        firstPiece === undefined
            ? [quote, ...bodyChunks]
            : [concatMessages(quote, '\n', firstPiece), ...pieces.slice(1), ...bodyChunks.slice(1)];
    return chunks.filter((chunk) => chunk.text.length > 0);
};

/** Body chunks: answer text, [stopped] marker, tool / search records */
const buildBodyChunks = (
    options: FinalMessageBuildOptions
): FinalMessageChunk[] => {
    const {
        text,
        thinking,
        thinkingLink,
        groundingData,
        agentStats,
        wasStoppedByUser,
        maxLength = TELEGRAM_MAX_LENGTH,
        resolveContextLink,
    } = options;

    // The Gemini search-grounding step the footer is built from; its supports
    // place the superscript markers in the body
    const searchGrounding = (groundingData ?? []).find(isSearchGroundingStep);

    // Records of the run: the merged tool-call blocks, plus Gemini's search
    // grounding in its own dedicated block
    const googleSearchBlocks = buildGoogleSearchBlocks(groundingData ?? []);
    const recordSections = [
        ...buildToolRecordSections(agentStats, groundingData ?? []),
        ...googleSearchBlocks.map((block) => block.message),
    ];

    // The CoT quote is rendered on its own so a split can keep it whole: the
    // first message carries the complete thinking (see splitAfterQuote).
    const quote =
        thinking && !thinkingLink
            ? linkifyContextNumbers(
                  renderThinkingQuote(thinking, { expandable: true }),
                  resolveContextLink
              )
            : undefined;

    const bodyParts: (RenderedMessage | string)[] = [];
    if (text) {
        bodyParts.push(renderMarkdown(withCitations(text, searchGrounding)));
    }

    // A bare stopped reply has no place for the marker: the link message must
    // stay a pure link (design §4.4). With a body the marker rides on it.
    const stoppedMarkerFits =
        wasStoppedByUser === true &&
        (thinkingLink === undefined || Boolean(text) || recordSections.length > 0);
    if (stoppedMarkerFits) {
        bodyParts.push('\n\n', plainText('[stopped]'));
    }
    for (const section of recordSections) {
        bodyParts.push('\n', section);
    }

    const body = bodyParts.length
        ? linkifyContextNumbers(concatMessages(...bodyParts), resolveContextLink)
        : concatMessages();

    if (quote === undefined && body.text.trim() === '') return [];

    let chunks: RenderedMessage[];
    if (quote === undefined) {
        chunks = splitMessage(body, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
    } else if (body.text.trim() === '') {
        chunks = splitMessage(quote, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
    } else {
        const combined = concatMessages(quote, '\n', body);
        chunks = splitMessage(combined, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
        if (quote.text.length <= maxLength && quoteSplitAcrossChunks(quote, chunks)) {
            chunks = splitAfterQuote(quote, body, maxLength);
        }
    }

    return applyLinkPreviewPolicy(
        chunks.filter((chunk) => chunk.text.length > 0),
        googleSearchBlocks
    );
};
