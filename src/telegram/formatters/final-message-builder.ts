/**
 * Final response assembly: collapsed thinking quote + markdown-rendered text
 * + tool-call / sources sections and the GoogleSearch footer, composed as
 * entity messages that fit the length, entity and entity-URL budgets.
 * Formatting spanning a boundary is closed and reopened by the splitter, so
 * styles are seamless across messages.
 *
 * The footer is assembled apart from the answer (design 2026-1113-1831): it
 * rides on the last answer message when it still fits there, becomes one
 * message of its own when it does not, and — when it cannot fit one message at
 * all and the caller passed a page link — turns into one compact link message
 * at the end of the reply instead of a chain of quote-block fragments. Without
 * a page link an overflowing footer keeps the old merged split, which cuts it.
 */
import { concatMessages, renderMarkdown, splitMessage } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { getRenderConfig } from '../../config/render-config.js';
import { stripPerQueryResultCitations } from '../../shared/citation-markers.js';
import type { SearchPageLink } from '../../shared/search-page.js';
import { buildToolRecordSections } from './tool-records-formatter.js';
import {
    buildGoogleSearchDocument,
    isSearchGroundingStep,
    renderGoogleSearchFooter,
    type GoogleSearchDocument,
} from './google-search-document.js';
import { searchLinkStatsOf, toSearchLinkChunk } from './google-search-link.js';
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
 * The rich body places the same markers (rich-reply-body.ts).
 */
export const withCitations = (text: string, grounding: GroundingData | undefined): string => {
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
    /**
     * Public page of a folded GoogleSearch footer (design 2026-1113-1831):
     * instead of a chain of quote-block fragments the footer becomes one
     * compact link message at the end of the reply. Its presence is the layout
     * decision, so only callers that decided to fold pass it — the live layout
     * when the footer overflows, a replay whose stored version has the token.
     */
    searchLink?: SearchPageLink;
    /**
     * The prebuilt footer document. Optional: the footer is always assembled in
     * two phases, this only spares the caller's grounding payload a second
     * parse when it already built the document for the fold trigger.
     */
    googleSearch?: GoogleSearchDocument;
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
 * One preview per reply. An inline search footer can span several messages: the
 * card for its first linked query rides on the chunk that starts it. Without a
 * linked query, only the last chunk keeps Telegram's default. Every other chunk
 * disables its preview so one reply cannot produce several cards.
 */
const applyLinkPreviewPolicy = (
    chunks: RenderedMessage[],
    firstQueryUrl: string | undefined
): FinalMessageChunk[] => {
    if (chunks.length === 0) return [];

    if (firstQueryUrl !== undefined) {
        const previewIndex = chunks.findIndex((chunk) =>
            chunk.entities.some((entity) => entity.url === firstQueryUrl)
        );

        if (previewIndex >= 0) {
            return chunks.map((chunk, index): FinalMessageChunk =>
                index === previewIndex
                    ? { ...chunk, linkPreviewOptions: { url: firstQueryUrl } }
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

/** Folded footer: the answer keeps no card of its own, the link message carries it */
const disablePreviews = (chunks: readonly RenderedMessage[]): FinalMessageChunk[] =>
    chunks.map((chunk) => ({ ...chunk, linkPreviewOptions: disabledLinkPreview }));

export const buildFinalMessages = (
    options: FinalMessageBuildOptions
): FinalMessageChunk[] => {
    const bodyChunks = buildBodyChunks(options);
    // The CoT link message leads the reply. It never goes through the split: it
    // is one fixed link plus the italic stats of the CoT it hides, and its own
    // preview card must survive the body's policy. The folded search footer is
    // already the last body chunk (buildBodyChunks appends it).
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

/** Answer chunks: the split the reply always had, without the footer */
const splitAnswer = (
    quote: RenderedMessage | undefined,
    answer: RenderedMessage,
    maxLength: number
): RenderedMessage[] => {
    let chunks: RenderedMessage[];
    if (quote === undefined && answer.text.trim() === '') return [];
    if (quote === undefined) {
        chunks = splitMessage(answer, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
    } else if (answer.text.trim() === '') {
        chunks = splitMessage(quote, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
    } else {
        const combined = concatMessages(quote, '\n', answer);
        chunks = splitMessage(combined, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES });
        if (quote.text.length <= maxLength && quoteSplitAcrossChunks(quote, chunks)) {
            chunks = splitAfterQuote(quote, answer, maxLength);
        }
    }
    return chunks.filter((chunk) => chunk.text.length > 0);
};

/**
 * Everything the layout is assembled from, computed once. The `#N` context
 * links are placed later: the merged layout places them over the whole body,
 * the two-phase layout over the answer and the footer separately.
 */
interface ReplyLayoutParts {
    /** The collapsed CoT quote (inline mode only) */
    readonly quote?: RenderedMessage;
    /** Answer text, [stopped] marker and tool-call records */
    readonly answer: RenderedMessage;
    /** The GoogleSearch footer, every block of it, or an empty message */
    readonly footer: RenderedMessage;
    readonly footerPresent: boolean;
    readonly document: GoogleSearchDocument;
    readonly maxLength: number;
    readonly resolveContextLink?: ContextLinkResolver;
}

const layoutPartsOf = (options: FinalMessageBuildOptions): ReplyLayoutParts => {
    const {
        text,
        thinking,
        thinkingLink,
        groundingData,
        googleSearch,
        agentStats,
        wasStoppedByUser,
        maxLength = TELEGRAM_MAX_LENGTH,
        resolveContextLink,
    } = options;

    // The Gemini search-grounding step the footer is built from; its supports
    // place the superscript markers in the body
    const searchGrounding = (groundingData ?? []).find(isSearchGroundingStep);

    // The footer document is passed in when the caller already built it (the
    // fold trigger reads it); otherwise it is rebuilt from the grounding steps
    const document = googleSearch ?? buildGoogleSearchDocument(groundingData ?? []);
    const footer = renderGoogleSearchFooter(document);
    const footerPresent = footer.text.trim() !== '';
    const toolSections = buildToolRecordSections(agentStats, groundingData ?? []);

    // The CoT quote is rendered on its own so a split can keep it whole: the
    // first message carries the complete thinking (see splitAfterQuote).
    const quote =
        thinking && !thinkingLink
            ? linkifyContextNumbers(
                  renderThinkingQuote(thinking, { expandable: true }),
                  resolveContextLink
              )
            : undefined;

    const answerParts: (RenderedMessage | string)[] = [];
    if (text) {
        answerParts.push(renderMarkdown(withCitations(text, searchGrounding)));
    }

    // A bare stopped reply has no place for the marker: the link message must
    // stay a pure link (design §4.4). With a body the marker rides on it.
    const stoppedMarkerFits =
        wasStoppedByUser === true &&
        (thinkingLink === undefined || Boolean(text) || toolSections.length > 0 || footerPresent);
    if (stoppedMarkerFits) {
        answerParts.push('\n\n', plainText('[stopped]'));
    }
    for (const section of toolSections) {
        answerParts.push('\n', section);
    }

    const answer = answerParts.length ? concatMessages(...answerParts) : concatMessages();

    return {
        quote,
        answer,
        footer,
        footerPresent,
        document,
        maxLength,
        resolveContextLink,
    };
};

/**
 * Today's layout: the footer is one more record section of the body and the
 * split may cut it. Only reached when the footer needs more than one message
 * and no page link was passed — the fallback that keeps old versions and a
 * switched-off feature rendering exactly as before.
 */
const mergedChunks = (parts: ReplyLayoutParts): FinalMessageChunk[] => {
    const { quote, answer, footer, footerPresent, document, maxLength, resolveContextLink } =
        parts;
    const body = linkifyContextNumbers(
        footerPresent ? concatMessages(answer, '\n', footer) : answer,
        resolveContextLink
    );
    return applyLinkPreviewPolicy(splitAnswer(quote, body, maxLength), document.firstQueryUrl);
};

/**
 * Put the whole footer on the last answer chunk when it still fits there;
 * otherwise it goes out as one message of its own. The footer is never split
 * at this stage — the folded link message exists for the case where it cannot
 * fit one message at all.
 */
const attachFooter = (
    answerChunks: readonly RenderedMessage[],
    footer: RenderedMessage,
    maxLength: number
): RenderedMessage[] => {
    const last = answerChunks[answerChunks.length - 1];
    if (last === undefined) return [footer];
    const combined = concatMessages(last, '\n', footer);
    const fits = splitMessage(combined, { maxLength, maxEntities: TELEGRAM_MAX_ENTITIES }).length <= 1;
    return fits ? [...answerChunks.slice(0, -1), combined] : [...answerChunks, footer];
};

/** Two-phase layout: answer chunks, then the footer folded or kept whole */
const twoPhaseChunks = (
    parts: ReplyLayoutParts,
    searchLink: SearchPageLink | undefined
): FinalMessageChunk[] => {
    const answer = linkifyContextNumbers(parts.answer, parts.resolveContextLink);
    const answerChunks = splitAnswer(parts.quote, answer, parts.maxLength);

    // No footer: nothing to fold (a stale page link must never add an empty
    // message), and the answer keeps the normal preview policy.
    if (!parts.footerPresent) {
        return applyLinkPreviewPolicy(answerChunks, parts.document.firstQueryUrl);
    }

    // A page link is only passed when the layout is folded (the live layout saw
    // an overflowing footer, or a stored version carries the page token): the
    // whole footer becomes one small message at the end and the answer carries
    // no preview card.
    if (searchLink !== undefined) {
        return [
            ...disablePreviews(answerChunks),
            toSearchLinkChunk(searchLink, searchLinkStatsOf(parts.document)),
        ];
    }

    const footer = linkifyContextNumbers(parts.footer, parts.resolveContextLink);
    const footerChunks = splitMessage(footer, {
        maxLength: parts.maxLength,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    });
    const footerChunk = footerChunks[0];
    if (footerChunks.length > 1 || footerChunk === undefined) {
        // No page link was available: keep today's merged split, which cuts the
        // footer rather than dropping it.
        console.warn(
            '[final-message-builder] the GoogleSearch footer needs more than one message and no search page link was passed; keeping the merged split'
        );
        return mergedChunks(parts);
    }

    return applyLinkPreviewPolicy(
        attachFooter(answerChunks, footerChunk, parts.maxLength),
        parts.document.firstQueryUrl
    );
};

/**
 * Body chunks: answer text, [stopped] marker, tool records and the search
 * footer. The answer and the footer are laid out in two phases — a footer that
 * fits one message is never cut in half, and an overflowing one either folds
 * into the page link message or falls back to today's merged split.
 */
const buildBodyChunks = (
    options: FinalMessageBuildOptions
): FinalMessageChunk[] => twoPhaseChunks(layoutPartsOf(options), options.searchLink);
