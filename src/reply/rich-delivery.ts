/**
 * Rich-message delivery of a reply body (the chat's richReplies switch).
 *
 * The decision is made once, when the chat context is built. The only change
 * afterwards is a one-way demotion to the entities path: a refused rich frame,
 * a body over the size budget or a final rich body that did not go through
 * hands the reply to the code every other reply takes, which re-lays out over
 * the same messages. What is not body text (the placeholder, the thinking-link
 * and search-link messages, media and their captions) stays entities either
 * way, and one of those that fails never demotes a delivered body.
 *
 * An answer may embed pictures (`![图注](g1)` on a paragraph of its own, see
 * rich-inline-media/scan.ts). They are resolved once, before any delivery
 * decision (prepareInlineReply), and the final body uploads them with its own
 * edit or send. A body Telegram refuses or that does not fit still keeps the
 * reply rich: the picture-free body goes out instead and every resolved picture
 * follows as trailing messages (L2), and only if that is refused as well does
 * the reply fall to entities (L3).
 */
import type { Context } from 'grammy';
import type { Message, RichBlock } from 'grammy/types';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { match } from 'ts-pattern';
import { toRichHtml } from 'telegram-md-entities';
import type { AIResponse } from '../ai/types.js';
import type { CommandType } from '../db/index.js';
import { beginThinkingLink } from '../panel/thinking/thinking-link-service.js';
import type { BotMessageSession } from '../services/bot-message-service.js';
import { liveThinkingKeyOf } from '../services/index.js';
import {
    MAX_REPLY_IMAGES,
    MAX_REPLY_IMAGE_TOTAL_BYTES,
    type ReplyImageDelivery,
    type ReplyImageDeliveryMode,
} from '../shared/reply-media.js';
import { layOutChunks, type LayoutChunk, type RichMediaPayload, richMediaPayloadOf } from '../telegram/final-message-layout.js';
import type { ContextLinkResolver } from '../telegram/formatters/context-links.js';
import { italicText } from '../telegram/formatters/entity-text.js';
import { buildErrorLine } from '../telegram/formatters/error-display.js';
import type { GoogleSearchDocument } from '../telegram/formatters/google-search-document.js';
import { searchLinkStatsOf, toSearchLinkChunk } from '../telegram/formatters/google-search-link.js';
import { TELEGRAM_MAX_LENGTH } from '../telegram/formatters/message-budget.js';
import { joinRichBlocks } from '../telegram/formatters/rich-blocks.js';
import { replaceSentinelsWithCaptionText } from '../telegram/formatters/rich-inline-media/media-blocks.js';
import { scanInlineMarkers } from '../telegram/formatters/rich-inline-media/scan.js';
import {
    buildRichAnswer,
    buildRichErrorDisplay,
    buildRichReplyBodyFromAnswer,
    searchFooterPresent,
} from '../telegram/formatters/rich-reply-body.js';
import { thinkingLinkSummaryOf, toThinkingLinkChunk } from '../telegram/formatters/thinking-link.js';
import type { StreamingEditor } from '../telegram/streaming-editor.js';
import { withKeptRoundsLine } from './resume/keep-checkpoint.js';

/** How a reply's body goes out */
export type ReplyDelivery = 'entities' | 'rich';

/**
 * The largest rich markdown source (UTF-16 length) a reply sends. Telegram
 * counts 32768 characters of rendered rich text; the source is longer than
 * what it renders, so this stays on the safe side without counting blocks
 * (a refusal of too many blocks demotes the reply like any other refusal).
 * The tag of each `#N` context link (about 47 characters) counts too: an
 * answer with hundreds of references reaches it early and goes on as
 * entities, which link them as well. A body with media blocks spends about
 * 40+caption characters per picture of the same budget.
 */
export const RICH_MAX_SOURCE_LENGTH = 30_000;

export type RichFallbackReason = 'stream-rejected' | 'overflow' | 'final-rejected' | 'error-rejected';

/** What delivery needs of a running reply; the ChatContext is one */
export interface RichDeliveryHolder {
    readonly ctx: Context;
    readonly chatId: number;
    readonly userMessageId: number;
    readonly session: BotMessageSession;
    /** The editor of the message the reply currently streams into */
    readonly editor: StreamingEditor;
    delivery: ReplyDelivery;
}

/** The delivery a reply starts with: rich only for a chat reply in a chat that asks for it */
export const initialDeliveryOf = (richReplies: boolean, commandType: CommandType): ReplyDelivery =>
    match(commandType)
        // The image commands answer with a picture and a caption
        .with('picbanana', 'picgpt', (): ReplyDelivery => 'entities')
        .with('chat', (): ReplyDelivery => (richReplies ? 'rich' : 'entities'))
        .exhaustive();

/**
 * Hand the rest of the reply to the entities path; logged once, on the first
 * demotion. `detail` is Telegram's description of a refusal or the length that
 * did not fit.
 */
export const demoteToEntities = (
    holder: RichDeliveryHolder,
    reason: RichFallbackReason,
    detail: string | number
): void => {
    if (holder.delivery !== 'rich') return;
    holder.delivery = 'entities';
    console.warn(
        `[rich] fallback to entities chat=${holder.chatId} first=${holder.session.firstMessageId} reason=${reason} detail=${detail}`
    );
};

/**
 * What the reply keeps of its inline pictures, besides the messages it sent.
 * The response handler owns the version/finalize side and copies these after
 * the final delivery, exactly like `delivery` itself.
 */
export interface RichInlineHolder {
    /** The delivery form the reply started with: a demoted reply still scans its pictures */
    readonly initialDelivery?: ReplyDelivery;
    /** The reply may embed the answer's pictures (no chat whitelist: rich replies can) */
    readonly inlineImagesEnabled?: boolean;
    /** The rich body source with the media sentinels (display only, never stored) */
    inlineAssemblyText?: string;
    /** The pictures the body embeds, in answer order */
    inlineImages?: ReplyImageDelivery[];
    /** How the pictures went out: inline in the body, as trailing messages, or nowhere */
    inlineDelivery?: ReplyImageDeliveryMode;
    /** The answer section exactly as the body delivered it (the replay snapshot) */
    richAnswerMarkdown?: string;
}

/** The bytes one inline ref resolves to; C1's media-ref-resolver provides them */
export interface InlineRefBytes {
    readonly data: Buffer;
    readonly mimeType: string;
}

export interface PrepareInlineReplyOptions {
    /**
     * Resolve one ref to its bytes; null when the picture cannot be embedded
     * (a GIF, a failed download, an unknown id). The resolver is C1's, so both
     * paths (send_image and an inline marker) behave the same.
     */
    readonly resolveRef: (ref: string) => Promise<InlineRefBytes | null>;
    /** The text to scan; the stream buffer by default (a reply that never streamed passes its text) */
    readonly text?: string;
}

const mediaModelOf = (image: ReplyImageDelivery): { readonly id: string; readonly caption: string } => ({
    id: image.id ?? '',
    caption: image.caption ?? '',
});

/**
 * Scan the answer for inline picture markers, once, before anything is
 * delivered: the reply's text becomes the clean one (display, storage, the
 * entities fallback and the next context all read it), the body source with its
 * sentinels is kept aside, and the pictures are resolved in parallel.
 *
 * A picture that does not resolve keeps its caption as text in the body and
 * never blocks the others. The 10-picture and 40MB budgets are applied here, in
 * answer order (the inline ones come before any `send_image` attachment).
 */
export const prepareInlineReply = async (
    holder: RichDeliveryHolder & RichInlineHolder,
    options: PrepareInlineReplyOptions
): Promise<void> => {
    // Once per reply: the scan already replaced the buffer
    if (holder.inlineAssemblyText !== undefined) return;
    const { session } = holder;
    const raw = session.textBuffer !== '' ? session.textBuffer : options.text ?? '';
    if (raw === '') return;
    const embed = holder.inlineImagesEnabled === true;
    const scanned = scanInlineMarkers(raw, { embed });
    // Everything that is not the rich body reads the clean text
    session.textBuffer = scanned.cleanText;
    holder.inlineAssemblyText = scanned.assemblyText;
    if (!embed || scanned.placements.length === 0) return;

    const placements = scanned.placements.slice(0, MAX_REPLY_IMAGES);
    const dropped = scanned.placements.slice(MAX_REPLY_IMAGES);
    // A picture past the limit keeps its caption as text where the block would
    // have been, like one that fails to resolve: the answer still says what it
    // meant there. An empty caption leaves nothing.
    const captionText = new Map<string, string>();
    for (const placement of dropped) {
        console.warn(
            `[rich-inline] inline picture dropped chat=${holder.chatId} ref=${placement.ref} reason=over-limit`
        );
        captionText.set(placement.mediaId, placement.caption);
    }
    const resolved = await Promise.all(
        placements.map(async (placement) => {
            try {
                return await options.resolveRef(placement.ref);
            } catch (error) {
                // Isolation: one bad picture never fails the reply or the others
                console.warn(
                    `[rich-inline] inline picture failed chat=${holder.chatId} ref=${placement.ref}:`,
                    error instanceof Error ? error.message : error
                );
                return null;
            }
        })
    );

    const images: ReplyImageDelivery[] = [];
    let totalBytes = 0;
    placements.forEach((placement, index) => {
        const bytes = resolved[index];
        if (bytes === null || bytes === undefined) {
            captionText.set(placement.mediaId, placement.caption);
            return;
        }
        if (totalBytes + bytes.data.length > MAX_REPLY_IMAGE_TOTAL_BYTES) {
            console.warn(
                `[rich-inline] inline picture dropped chat=${holder.chatId} ref=${placement.ref} reason=over-bytes`
            );
            captionText.set(placement.mediaId, placement.caption);
            return;
        }
        totalBytes += bytes.data.length;
        images.push({
            placement: 'inline',
            data: bytes.data,
            mimeType: bytes.mimeType,
            ...(placement.caption === '' ? {} : { caption: placement.caption }),
            id: placement.mediaId,
        });
    });
    // A picture that did not resolve leaves its caption (or nothing) where the
    // media block would have been
    holder.inlineAssemblyText = replaceSentinelsWithCaptionText(holder.inlineAssemblyText, captionText);
    holder.inlineImages = images;
    if (images.length > 0) {
        console.log(
            `[rich-inline] inline pictures chat=${holder.chatId} resolved=${images.length} ` +
            `of=${scanned.placements.length} bytes=${totalBytes}`
        );
    }
};

export interface RichFinalInput {
    /** The final response, with the tool usage a stop shows already filled in */
    readonly response: AIResponse;
    /** The GoogleSearch footer, prepared once (its fold decided) */
    readonly googleSearch: GoogleSearchDocument;
    readonly wasStoppedByUser: boolean;
    readonly resolveContextLink?: ContextLinkResolver;
}

export type RichFinalKind = 'delivered' | 'not-attempted' | 'rejected';

/** What the reply must still deliver as trailing messages (L2/L3: the inline pictures as attachments) */
export interface RichFinalFallback {
    readonly images: readonly ReplyImageDelivery[];
}

/**
 * delivered: the body is in the chat as a rich message; media, finalize and
 * buttons follow. not-attempted: nothing was sent, the entities path delivers
 * as usual. rejected: the rich body did not go through and the reply is
 * demoted; the entities path re-lays out over the messages it left, and the
 * fallback pictures go out as attachments after it.
 */
export interface RichFinalResult {
    readonly kind: RichFinalKind;
    /** L2 delivered still sent the pictures, but not inside the body */
    readonly fallback?: RichFinalFallback;
}

/** Where the final shows the thinking: in the body, behind the link the reply has, or behind a new one */
type ThinkingPlacement = 'inline' | 'link' | 'new-link';

const thinkingPlacementOf = (session: BotMessageSession, thinking: string): ThinkingPlacement => {
    if (session.thinkingLink !== undefined) return 'link';
    // The same cap the entities layout keeps a quote under
    return thinking.length <= TELEGRAM_MAX_LENGTH ? 'inline' : 'new-link';
};

/**
 * The link the final leads with when the thinking is too long for the body.
 * false keeps the thinking in the body: no link could be created.
 */
const beginFinalThinkingLink = async (holder: RichDeliveryHolder): Promise<boolean> => {
    const { session } = holder;
    const ref = await beginThinkingLink({
        chatId: holder.chatId,
        firstMessageId: session.firstMessageId,
        versionId: session.versionCount + 1,
        model: session.model,
    });
    if (ref === null) return false;
    session.thinkingLink = { ...ref, key: liveThinkingKeyOf(session), emitted: false };
    return true;
};

/** The note a body without the pictures ends with (L2), its own italic paragraph */
const mediaNoteBlock = (count: number): string =>
    toRichHtml(italicText(`（另有 ${count} 张图未能内嵌发送）`));

/** `![]()` media block occurrences: the number of photo blocks the body should deliver */
const expectedPhotoBlocks = (markdown: string): number => {
    const matched = markdown.match(/!\[\]\(tg:\/\/photo\?id=[^)]*\)/g);
    return matched?.length ?? 0;
};

/** How many photo blocks a delivered rich message shows at its top level */
const deliveredPhotoBlocks = (message: Message): number | null => {
    if (!('rich_message' in message)) return null;
    const blocks: readonly RichBlock[] | undefined = message.rich_message?.blocks;
    if (blocks === undefined) return null;
    return blocks.filter((block) => block.type === 'photo').length;
};

/**
 * Check the delivered body against the pictures it declared (§5.8): a caption
 * that broke a media block line drops its picture with 200 and no error, so the
 * only way to notice is to count the blocks the message came back with.
 * Never blocks: the message is already in the chat.
 */
const checkDeliveredBlocks = (
    holder: RichDeliveryHolder,
    message: Message | undefined,
    body: string,
    kindTag: string
): void => {
    const expected = expectedPhotoBlocks(body);
    if (expected === 0) return;
    if (message === undefined) {
        console.warn(`[rich-inline] media blocks unverified chat=${holder.chatId} ${kindTag} expected=${expected}`);
        return;
    }
    const delivered = deliveredPhotoBlocks(message);
    if (delivered === null) {
        console.warn(`[rich-inline] media blocks unverified chat=${holder.chatId} ${kindTag} expected=${expected}`);
        return;
    }
    if (delivered !== expected) {
        console.warn(
            `[rich-inline] media blocks mismatch chat=${holder.chatId} ${kindTag} expected=${expected} delivered=${delivered}`
        );
    }
};

/**
 * Lay the reply's final text out as [thinking link] + rich body + [search
 * link] over the messages the stream left. The link messages stay entities:
 * they need their preview cards, which a rich message cannot carry.
 */
export const deliverRichFinal = async (
    holder: RichDeliveryHolder & RichInlineHolder,
    input: RichFinalInput
): Promise<RichFinalResult> => {
    const { session } = holder;
    // The stream syncs the complete buffers; a caller that never streamed only
    // has the response. The body source keeps a sentinel per embedded picture.
    const cleanText = session.textBuffer !== '' ? session.textBuffer : input.response.text;
    const assemblyText = holder.inlineAssemblyText ?? cleanText;
    const thinking = session.thinkingBuffer !== '' ? session.thinkingBuffer : input.response.thinkingText;
    const searchFolded = session.searchLink !== undefined && searchFooterPresent(input.googleSearch);
    const inlineImages = holder.inlineImages ?? [];
    const groundingData = input.response.groundingData;

    // The answer as the body shows it: with the media blocks, and without them
    const answerWithMedia =
        assemblyText.trim() === '' && inlineImages.length === 0
            ? ''
            : buildRichAnswer({
                  text: assemblyText,
                  ...(groundingData === undefined ? {} : { groundingData }),
                  ...(input.resolveContextLink === undefined ? {} : { resolveContextLink: input.resolveContextLink }),
                  inlineMedia: inlineImages.filter((image) => image.id !== undefined).map(mediaModelOf),
              });
    // The picture-free answer, ending with the note (only a reply that has pictures can degrade)
    const answerPlain =
        inlineImages.length === 0
            ? answerWithMedia
            : joinRichBlocks([buildRichAnswer({
                  text: cleanText,
                  ...(groundingData === undefined ? {} : { groundingData }),
                  ...(input.resolveContextLink === undefined ? {} : { resolveContextLink: input.resolveContextLink }),
              }), mediaNoteBlock(inlineImages.length)]);
    const bodyOf = (answerMarkdown: string, thinkingToShow: string | undefined): string | null =>
        buildRichReplyBodyFromAnswer({
            answerMarkdown,
            ...(thinkingToShow === undefined ? {} : { thinking: thinkingToShow }),
            ...(groundingData === undefined ? {} : { groundingData }),
            googleSearch: input.googleSearch,
            ...(input.response.agentStats === undefined ? {} : { agentStats: input.response.agentStats }),
            wasStoppedByUser: input.wasStoppedByUser,
            searchFolded,
            ...(input.resolveContextLink === undefined ? {} : { resolveContextLink: input.resolveContextLink }),
        });
    const payloads: RichMediaPayload[] = inlineImages
        .filter((image) => image.id !== undefined)
        .map((image) => richMediaPayloadOf(image.id ?? '', image.data));

    const placement = thinkingPlacementOf(session, thinking);
    const bodyKinds = inlineImages.length > 0 ? (['media', 'plain'] as const) : (['media'] as const);
    type BodyKind = (typeof bodyKinds)[number];
    const bodyOfKind = (kind: BodyKind, thinkingToShow: string | undefined): string | null =>
        bodyOf(kind === 'media' ? answerWithMedia : answerPlain, thinkingToShow);

    /** The first body that fits the budget, in preference order (with pictures first) */
    const pickBody = (thinkingToShow: string | undefined): { readonly kind: BodyKind; readonly body: string } | null => {
        for (const kind of bodyKinds) {
            const body = bodyOfKind(kind, thinkingToShow);
            if (body !== null && body.length <= RICH_MAX_SOURCE_LENGTH) return { kind, body };
        }
        return null;
    };

    /**
     * Nothing rich fits the budget: the entities layout takes over. The resolved
     * pictures stay on the reply, so the entities path sends them as trailing
     * messages instead of losing them.
     */
    const abandonOverflow = (detail: number): RichFinalResult => {
        demoteToEntities(holder, 'overflow', detail);
        return { kind: 'not-attempted' };
    };

    /** The reply gives up rich delivery; the pictures go out as attachments (L3) */
    const giveUp = (reason: RichFallbackReason, detail: string | number): RichFinalResult => {
        demoteToEntities(holder, reason, detail);
        const fallback = inlineImages.length === 0 ? undefined : { images: [...inlineImages] };
        holder.inlineImages = [];
        if (fallback !== undefined) holder.inlineDelivery = 'dropped';
        return { kind: 'rejected', ...(fallback === undefined ? {} : { fallback }) };
    };

    // The thinking shows in the body only when it is not behind a link
    let bodyThinking: string | undefined = placement === 'inline' ? thinking : undefined;
    let picked = pickBody(bodyThinking);
    if (picked === null) {
        const firstBody = bodyOfKind(bodyKinds[0], bodyThinking);
        if (firstBody === null) return { kind: 'not-attempted' };
        return abandonOverflow(firstBody.length);
    }
    if (placement === 'new-link' && !(await beginFinalThinkingLink(holder))) {
        // No link: the thinking would have to go inline. One longer than the
        // whole budget cannot fit, and rendering it (up to 500k characters)
        // takes seconds that block the bot, so its length alone decides, as on
        // the entities path.
        if (thinking.length > RICH_MAX_SOURCE_LENGTH) return abandonOverflow(thinking.length);
        bodyThinking = thinking;
        const withThinking = pickBody(bodyThinking);
        if (withThinking === null) return abandonOverflow(thinking.length);
        picked = withThinking;
    }

    const link = session.thinkingLink;
    const linkEmitted = link?.emitted === true;
    const searchChunk: readonly LayoutChunk[] =
        searchFolded && session.searchLink !== undefined
            ? [toSearchLinkChunk(session.searchLink, searchLinkStatsOf(input.googleSearch))]
            : [];
    const linkChunks = (): readonly LayoutChunk[] =>
        link === undefined || linkEmitted
            ? []
            : [toThinkingLinkChunk(link, thinkingLinkSummaryOf(thinking) ?? undefined)];
    // The link message the stream already sent leads the reply and stays as it is
    const layoutMessageIds = (): readonly number[] =>
        linkEmitted ? session.messageIds.slice(1) : session.messageIds;

    /** One attempt at the final layout; the body chunk is the only one that can carry media */
    const layOut = async (
        kind: BodyKind,
        body: string
    ): Promise<{ readonly refusal: string | undefined; readonly delivered: boolean }> => {
        const bodyChunk: LayoutChunk = {
            richMarkdown: body,
            ...(kind === 'media' && payloads.length > 0 ? { richMedia: payloads } : {}),
        };
        let refusal: string | undefined;
        let message: Message | undefined;
        const laidOut = await layOutChunks({
            api: holder.ctx.api,
            chatId: holder.chatId,
            userMessageId: holder.userMessageId,
            firstMessageId: session.firstMessageId,
            messageIds: layoutMessageIds(),
            chunks: [...linkChunks(), bodyChunk, ...searchChunk],
            onRichRejected: (error) => {
                refusal ??= error.description;
            },
            onRichDelivered: (delivered) => {
                message ??= delivered;
            },
        });
        // Set before any outcome: the entities re-layout starts from these messages
        session.messageIds = linkEmitted
            ? [...session.messageIds.slice(0, 1), ...laidOut.messageIds]
            : laidOut.messageIds;
        session.currentMessageId = laidOut.currentMessageId;
        if (laidOut.richDelivered) {
            checkDeliveredBlocks(holder, message, body, kind);
            // The body is in the chat: a link message or a surplus delete that
            // failed is only logged, as on the entities path. Demoting here
            // would rewrite the delivered body as entities, and the same
            // failure would cut it short.
            if (!laidOut.allDelivered) {
                console.warn(
                    `[rich] final layout did not fully deliver chat=${holder.chatId} first=${session.firstMessageId}`
                );
            }
        }
        return { refusal, delivered: laidOut.richDelivered };
    };

    const finishDelivered = (kind: BodyKind, body: string): RichFinalResult => {
        // A body with pictures delivered them inline; a picture-free body (L2) leaves them to the attachments
        holder.inlineDelivery = kind === 'plain' ? 'attachments' : 'rich';
        holder.richAnswerMarkdown = kind === 'media' ? answerWithMedia : answerPlain;
        if (payloads.length > 0) {
            console.log(
                `[rich-inline] media payload chat=${holder.chatId} pictures=${payloads.length} ` +
                `bytes=${payloads.reduce((total, picture) => total + picture.data.length, 0)} delivered=${kind === 'media'}`
            );
        }
        holder.inlineImages = kind === 'media' ? inlineImages : [];
        console.log(
            `[rich] delivered chat=${holder.chatId} first=${session.firstMessageId} chars=${body.length} ` +
            `link=${link !== undefined} searchLink=${searchFolded}`
        );
        return kind === 'media' ? { kind: 'delivered' } : { kind: 'delivered', fallback: { images: [...inlineImages] } };
    };

    const first = await layOut(picked.kind, picked.body);
    if (first.delivered) return finishDelivered(picked.kind, picked.body);

    // A non-429 refusal of a body with pictures: keep the reply rich without
    // them (L2). A 429 exhaustion goes straight to entities (L3): still being
    // rate limited, another rich body would only be refused again.
    if (picked.kind === 'media' && inlineImages.length > 0 && first.refusal !== undefined) {
        const plainPicked = bodyOfKind('plain', bodyThinking);
        if (plainPicked !== null && plainPicked.length <= RICH_MAX_SOURCE_LENGTH) {
            const second = await layOut('plain', plainPicked);
            if (second.delivered) return finishDelivered('plain', plainPicked);
        }
    }

    return giveUp('final-rejected', first.refusal ?? 'not delivered');
};

export interface RichErrorInput {
    /** The partial answer of the message the editor owns */
    readonly partialText: string;
    /** The partial thinking for the quote; undefined on a continuation */
    readonly partialThinking?: string;
    /** User-facing error description */
    readonly errorMessage: string;
    /** Rounds a kept checkpoint holds: adds the "已保留前 N 轮" line */
    readonly keptRounds?: number;
    readonly errorButtons?: InlineKeyboardMarkup;
    readonly resolveContextLink?: ContextLinkResolver;
    /** The reply may embed pictures: its half-written markers are hidden */
    readonly inlineImagesEnabled?: boolean;
}

/**
 * The error display as one final rich edit with the retry buttons. One over
 * the budget stays rich: it gives up the thinking quote, then the end of the
 * answer (the entities display would keep only its first 3,400 characters).
 * false means Telegram did not take it and the reply is demoted: the caller
 * shows the entities error display instead.
 */
export const deliverRichErrorDisplay = async (
    holder: RichDeliveryHolder,
    input: RichErrorInput
): Promise<boolean> => {
    const errorLine = buildErrorLine(input.errorMessage);
    const display = buildRichErrorDisplay({
        text: input.partialText,
        thinking: input.partialThinking,
        // The same lines the entities display ends with, display only
        errorLines: input.keptRounds === undefined ? errorLine : withKeptRoundsLine(errorLine, input.keptRounds),
        resolveContextLink: input.resolveContextLink,
        maxLength: RICH_MAX_SOURCE_LENGTH,
        ...(input.inlineImagesEnabled === undefined ? {} : { inlineImagesEnabled: input.inlineImagesEnabled }),
    });
    let refusal: string | undefined;
    const delivered = await holder.editor.updateRich(display, {
        replyMarkup: input.errorButtons,
        isFinal: true,
        onRejected: (error) => {
            refusal ??= error.description;
        },
    });
    if (!delivered) demoteToEntities(holder, 'error-rejected', refusal ?? 'not delivered');
    return delivered;
};
