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
import { toThinkingLinkChunk, type ThinkingLinkRef } from './thinking-link.js';

/** Safe per-message length budget (below Telegram's 4096 hard limit) */
const TELEGRAM_MAX_LENGTH = 4000;
/** Per-message entity budget (the server silently drops entities past ~100) */
const TELEGRAM_MAX_ENTITIES = 90;

/**
 * Display-only superscript markers: the stored reply text stays clean, so a
 * rerender (edit/retry) and the next turn's context never see them.
 */
const withCitations = (text: string, grounding: GroundingData | undefined): string => {
    if (grounding === undefined || !getRenderConfig().groundingCitations) return text;
    return inlineCitations(text, resolveGroundingSources(grounding), grounding.groundingSupports);
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
    // one fixed line, and its own preview card must survive the body's policy.
    return options.thinkingLink
        ? [toThinkingLinkChunk(options.thinkingLink), ...bodyChunks]
        : bodyChunks;
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

    const parts: (RenderedMessage | string)[] = [];

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

    // In link mode the thinking lives behind the link, never in the body
    if (thinking && !thinkingLink) {
        parts.push(renderThinkingQuote(thinking, { expandable: true }));
    }

    if (text) {
        if (parts.length) parts.push('\n');
        parts.push(renderMarkdown(withCitations(text, searchGrounding)));
    }

    // A bare stopped reply has no place for the marker: the link message must
    // stay a pure link (design §4.4). With a body the marker rides on it.
    const stoppedMarkerFits =
        wasStoppedByUser === true &&
        (thinkingLink === undefined || Boolean(text) || recordSections.length > 0);
    if (stoppedMarkerFits) {
        parts.push('\n\n', plainText('[stopped]'));
    }

    for (const section of recordSections) {
        parts.push('\n', section);
    }

    if (!parts.length) return [];

    // Before the split, so the added link entities count against its budget
    const combined = linkifyContextNumbers(concatMessages(...parts), resolveContextLink);
    if (!combined.text.trim()) return [];

    const chunks = splitMessage(combined, {
        maxLength,
        maxEntities: TELEGRAM_MAX_ENTITIES,
    }).filter((chunk) => chunk.text.length > 0);

    return applyLinkPreviewPolicy(chunks, googleSearchBlocks);
};
