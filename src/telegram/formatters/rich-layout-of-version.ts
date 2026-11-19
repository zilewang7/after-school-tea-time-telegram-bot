/**
 * A stored version as the chunk layout a replay lays out over the chat.
 *
 * The answer section is replayed from `version.richAnswerMarkdown` (the live
 * rendering, kept for exactly this), while the blocks around it — the thinking
 * quote, `[stopped]`, tool records and the inline search footer — are rebuilt
 * by the same formatter the live body used. A long-CoT link, a folded search
 * footer and a folded Tools block replay as their own messages, exactly where
 * the live layout put them.
 *
 * Inline pictures need bytes at replay time: `media` carries them (loaded from
 * media_cache by the caller). A picture whose bytes are gone loses its block
 * from the snapshot instead of breaking the whole body; the caller logs it.
 *
 * Layer: telegram (2). Only db types (lower) and telegram/shared helpers are
 * imported; no reply/services code, so services can call it for a version.
 */
import type { ResponseVersion } from '../../db/botResponseDTO.js';
import type { StoredReplyMedia } from '../../shared/reply-media.js';
import type { SearchPageLink } from '../../shared/search-page.js';
import type { ToolLogPageLink } from '../../shared/tool-log-page.js';
import { richMediaPayloadOf, type LayoutChunk } from '../final-message-layout.js';
import { buildGoogleSearchDocument } from './google-search-document.js';
import { searchLinkStatsOf, toSearchLinkChunk } from './google-search-link.js';
import type { ContextLinkResolver } from './context-links.js';
import { buildRichReplyBodyFromAnswer } from './rich-reply-body.js';
import { buildToolLogDocument } from './tool-log-document.js';
import { toToolLogLinkChunk } from './tool-log-link.js';
import { thinkingLinkSummaryOf, toThinkingLinkChunk, type ThinkingLinkRef } from './thinking-link.js';

/** One inline picture whose bytes a replay still has */
export interface RichReplayMedia {
    readonly id: string;
    readonly data: Buffer;
    readonly mimeType: string;
}

export interface RichLayoutOfVersionInput {
    readonly version: ResponseVersion;
    /** The CoT link message the version leads with; absent when it had none */
    readonly thinkingLink?: ThinkingLinkRef;
    /** The folded search footer's link message; absent when the footer fit inline */
    readonly searchLink?: SearchPageLink;
    /** The folded Tools block's link message; absent when the block fit inline */
    readonly toolsLink?: ToolLogPageLink;
    /** Inline pictures with bytes, in body order; ids not here lose their block */
    readonly media: readonly RichReplayMedia[];
    /** Context-link resolver for the rebuilt blocks around the answer */
    readonly resolveContextLink?: ContextLinkResolver;
}

export interface RichLayoutOfVersion {
    /** The version's messages: link, rich body, search link (as many as exist) */
    readonly chunks: LayoutChunk[];
    /** Inline pictures the body references, for the layout's media upload */
    readonly bodyMedia: readonly RichReplayMedia[];
    /** Inline picture ids whose block was removed because media_cache lost the bytes */
    readonly missingInlineIds: readonly string[];
    /** The body chunk could not be built (no answer text and no picture block): replay as entities */
    readonly bodyMissing: boolean;
}

/** A media block line: `![](tg://photo?id=img1 "caption")`, standalone by construction */
const INLINE_MEDIA_BLOCK = /^!\[[^\]]*\]\(tg:\/\/photo\?id=([A-Za-z0-9_-]+)(?:\s+"[^"]*")?\)$/;

const inlineMediaOf = (version: ResponseVersion): StoredReplyMedia[] =>
    (version.media ?? []).filter((media) => media.placement === 'inline' && media.id !== undefined);

/**
 * The snapshot with the given pictures' blocks removed. A block is one whole
 * paragraph, so dropping the paragraph is enough (the formatter joins blocks
 * with blank lines).
 */
const stripInlineMediaBlocks = (markdown: string, missingIds: ReadonlySet<string>): string =>
    markdown
        .split('\n\n')
        .filter((paragraph) => {
            const matched = INLINE_MEDIA_BLOCK.exec(paragraph.trim());
            return matched === null || !missingIds.has(matched[1] ?? '');
        })
        .join('\n\n');

/**
 * Build the replay layout of one stored version. `bodyMissing` is true when the
 * snapshot is empty (no answer text) — the caller then replays the version with
 * the entities layout instead of sending an empty rich body.
 */
export const buildRichLayoutOfVersion = (input: RichLayoutOfVersionInput): RichLayoutOfVersion => {
    const { version } = input;
    const mediaById = new Map(input.media.map((media) => [media.id, media]));
    const inlinePictures = inlineMediaOf(version);
    const missingInlineIds = inlinePictures
        .filter((picture) => picture.id !== undefined && !mediaById.has(picture.id))
        .map((picture) => picture.id ?? '');
    const missingIdSet = new Set(missingInlineIds);

    const snapshot = version.richAnswerMarkdown ?? '';
    const answerMarkdown = missingIdSet.size === 0
        ? snapshot
        : stripInlineMediaBlocks(snapshot, missingIdSet);

    const googleSearch = buildGoogleSearchDocument(version.groundingData ?? []);
    const toolLog = buildToolLogDocument(version.agentStats, version.groundingData ?? []);
    const bodyMarkdown = buildRichReplyBodyFromAnswer({
        answerMarkdown,
        // A version that showed the CoT link never showed the quote
        ...(input.thinkingLink === undefined && version.thinkingText !== undefined
            ? { thinking: version.thinkingText }
            : {}),
        ...(version.groundingData === undefined ? {} : { groundingData: version.groundingData }),
        googleSearch,
        ...(version.agentStats === undefined ? {} : { agentStats: version.agentStats }),
        wasStoppedByUser: version.wasStoppedByUser,
        searchFolded: input.searchLink !== undefined,
        toolsFolded: input.toolsLink !== undefined,
        ...(input.resolveContextLink === undefined
            ? {}
            : { resolveContextLink: input.resolveContextLink }),
    });

    const bodyMedia = inlinePictures.flatMap((picture) => {
        const media = picture.id === undefined ? undefined : mediaById.get(picture.id);
        return media === undefined ? [] : [media];
    });

    const chunks: LayoutChunk[] = [];
    if (input.thinkingLink !== undefined) {
        const summary = version.thinkingText === undefined
            ? undefined
            : thinkingLinkSummaryOf(version.thinkingText) ?? undefined;
        chunks.push(toThinkingLinkChunk(input.thinkingLink, summary));
    }
    if (bodyMarkdown !== null) {
        // The layout uploads the pictures with the same edit/send; a body
        // without pictures must stay a request without `media`
        chunks.push({
            richMarkdown: bodyMarkdown,
            ...(bodyMedia.length === 0
                ? {}
                : { richMedia: bodyMedia.map((media) => richMediaPayloadOf(media.id, media.data)) }),
        });
    }
    if (input.toolsLink !== undefined) {
        chunks.push(toToolLogLinkChunk(input.toolsLink, toolLog));
    }
    if (input.searchLink !== undefined) {
        chunks.push(toSearchLinkChunk(input.searchLink, searchLinkStatsOf(googleSearch)));
    }

    return {
        chunks,
        bodyMedia,
        missingInlineIds,
        bodyMissing: bodyMarkdown === null,
    };
};
