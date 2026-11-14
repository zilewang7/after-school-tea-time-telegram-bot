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
 */
import type { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { match } from 'ts-pattern';
import type { AIResponse } from '../ai/types.js';
import type { CommandType } from '../db/index.js';
import { beginThinkingLink } from '../panel/thinking/thinking-link-service.js';
import type { BotMessageSession } from '../services/bot-message-service.js';
import { liveThinkingKeyOf } from '../services/index.js';
import { layOutChunks, type LayoutChunk } from '../telegram/final-message-layout.js';
import type { ContextLinkResolver } from '../telegram/formatters/context-links.js';
import { buildErrorLine } from '../telegram/formatters/error-display.js';
import type { GoogleSearchDocument } from '../telegram/formatters/google-search-document.js';
import { searchLinkStatsOf, toSearchLinkChunk } from '../telegram/formatters/google-search-link.js';
import { TELEGRAM_MAX_LENGTH } from '../telegram/formatters/message-budget.js';
import {
    buildRichErrorDisplay,
    buildRichReplyBody,
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

export interface RichFinalInput {
    /** The final response, with the tool usage a stop shows already filled in */
    readonly response: AIResponse;
    /** The GoogleSearch footer, prepared once (its fold decided) */
    readonly googleSearch: GoogleSearchDocument;
    readonly wasStoppedByUser: boolean;
    readonly resolveContextLink?: ContextLinkResolver;
}

/**
 * delivered: the body is in the chat as a rich message (a link message that
 * failed is only logged); media, finalize and buttons follow. not-attempted:
 * nothing was sent, the entities path delivers as usual. rejected: the rich
 * body did not go through and the reply is demoted; the entities path
 * re-lays out over the messages it left.
 */
export type RichFinalOutcome = 'delivered' | 'not-attempted' | 'rejected';

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

/**
 * Lay the reply's final text out as [thinking link] + rich body + [search
 * link] over the messages the stream left. The link messages stay entities:
 * they need their preview cards, which a rich message cannot carry.
 */
export const deliverRichFinal = async (
    holder: RichDeliveryHolder,
    input: RichFinalInput
): Promise<RichFinalOutcome> => {
    const { session } = holder;
    // The stream syncs the complete buffers; a caller that never streamed only has the response
    const text = session.textBuffer !== '' ? session.textBuffer : input.response.text;
    const thinking = session.thinkingBuffer !== '' ? session.thinkingBuffer : input.response.thinkingText;
    const searchFolded = session.searchLink !== undefined && searchFooterPresent(input.googleSearch);
    const bodyWith = (inlineThinking: string | undefined): string | null =>
        buildRichReplyBody({
            text,
            thinking: inlineThinking,
            groundingData: input.response.groundingData,
            googleSearch: input.googleSearch,
            agentStats: input.response.agentStats,
            wasStoppedByUser: input.wasStoppedByUser,
            searchFolded,
            resolveContextLink: input.resolveContextLink,
        });

    const placement = thinkingPlacementOf(session, thinking);
    let body = bodyWith(placement === 'inline' ? thinking : undefined);
    if (body === null) return 'not-attempted';
    // Measured before a new link is created: the entities path creates its own
    if (body.length > RICH_MAX_SOURCE_LENGTH) {
        demoteToEntities(holder, 'overflow', body.length);
        return 'not-attempted';
    }
    if (placement === 'new-link' && !(await beginFinalThinkingLink(holder))) {
        // No link: the thinking would have to go inline. One longer than the
        // whole budget cannot fit, and rendering it (up to 500k characters)
        // takes seconds that block the bot, so its length alone decides, as on
        // the entities path.
        if (thinking.length > RICH_MAX_SOURCE_LENGTH) {
            demoteToEntities(holder, 'overflow', thinking.length);
            return 'not-attempted';
        }
        body = bodyWith(thinking) ?? body;
        if (body.length > RICH_MAX_SOURCE_LENGTH) {
            demoteToEntities(holder, 'overflow', body.length);
            return 'not-attempted';
        }
    }

    const link = session.thinkingLink;
    const linkEmitted = link?.emitted === true;
    const chunks: LayoutChunk[] = [
        ...(link === undefined || linkEmitted ? [] : [toThinkingLinkChunk(link, thinkingLinkSummaryOf(thinking) ?? undefined)]),
        { richMarkdown: body },
        ...(searchFolded && session.searchLink !== undefined
            ? [toSearchLinkChunk(session.searchLink, searchLinkStatsOf(input.googleSearch))]
            : []),
    ];

    let refusal: string | undefined;
    // A link message the stream already delivered leads the reply untouched
    const laidOut = await layOutChunks({
        api: holder.ctx.api,
        chatId: holder.chatId,
        userMessageId: holder.userMessageId,
        firstMessageId: session.firstMessageId,
        messageIds: linkEmitted ? session.messageIds.slice(1) : session.messageIds,
        chunks,
        onRichRejected: (error) => {
            refusal ??= error.description;
        },
    });
    // Set before any outcome: the entities re-layout starts from these messages
    session.messageIds = linkEmitted ? [...session.messageIds.slice(0, 1), ...laidOut.messageIds] : laidOut.messageIds;
    session.currentMessageId = laidOut.currentMessageId;

    if (!laidOut.richDelivered) {
        demoteToEntities(holder, 'final-rejected', refusal ?? 'not delivered');
        return 'rejected';
    }
    // The body is in the chat: a link message or a surplus delete that failed
    // is only logged, as on the entities path. Demoting here would rewrite the
    // delivered body as entities, and the same failure would cut it short.
    if (!laidOut.allDelivered) {
        console.warn(`[rich] final layout did not fully deliver chat=${holder.chatId} first=${session.firstMessageId}`);
    }
    console.log(
        `[rich] delivered chat=${holder.chatId} first=${session.firstMessageId} chars=${body.length} link=${link !== undefined} searchLink=${searchFolded}`
    );
    return 'delivered';
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
}

/**
 * The error display as one final rich edit with the retry buttons. false
 * means it is not in the chat and the reply is demoted: the caller shows the
 * entities error display instead.
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
    });
    if (display.length > RICH_MAX_SOURCE_LENGTH) {
        demoteToEntities(holder, 'overflow', display.length);
        return false;
    }
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
