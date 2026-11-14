/**
 * The reply body as one Telegram rich message (the chat's richReplies switch).
 *
 * Only the model's answer goes as markdown (`toRichMarkdown`): that is where
 * the native tables, headings and math come from. Everything the bot builds
 * itself — the thinking quote, the [stopped] marker, the tool records, the
 * search footer, the status and error lines — is already an exact
 * {text, entities} message and goes as HTML blocks (`toRichHtml`), so no
 * runtime string is ever re-escaped as markdown.
 *
 * The answer is always converted in streaming mode, also for the final: a
 * stopped or failed answer is a cut prefix, and even a finished one may leave
 * a fence or a tag open. Closing it keeps the blocks after the answer outside
 * of it (strict CommonMark would run an open fence over them).
 */
import { toRichHtml, toRichMarkdown } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { linkifyContextNumbers, type ContextLinkResolver } from './context-links.js';
import { plainText } from './entity-text.js';
import { withCitations } from './final-message-builder.js';
import {
    isSearchGroundingStep,
    renderGoogleSearchFooter,
    type GoogleSearchDocument,
} from './google-search-document.js';
import { renderThinkingQuote } from './quoted-render.js';
import { joinRichBlocks } from './rich-blocks.js';
import { formatThinkingForStreaming } from './thinking-display.js';
import { buildToolRecordSections } from './tool-records-formatter.js';

/** The collapsed thinking quote of a final or error display */
const thinkingQuoteBlock = (thinking: string | undefined, resolveContextLink?: ContextLinkResolver): string =>
    thinking === undefined || thinking === ''
        ? ''
        : toRichHtml(linkifyContextNumbers(renderThinkingQuote(thinking, { expandable: true }), resolveContextLink));

export interface RichStreamingFrameInput {
    /** The thinking display buffer; empty on a continuation, which never shows it */
    readonly thinking: string;
    /** The answer so far, already cleaned of context labels */
    readonly text: string;
    /** The answer has started: the whole thinking collapses */
    readonly answerStarted: boolean;
    readonly resolveContextLink?: ContextLinkResolver;
}

/** One streaming frame without the status line (the streaming editor appends it) */
export const buildRichStreamingFrame = (input: RichStreamingFrameInput): string =>
    joinRichBlocks([
        input.thinking === ''
            ? ''
            : toRichHtml(
                  linkifyContextNumbers(
                      formatThinkingForStreaming(input.thinking, { answerStarted: input.answerStarted }),
                      input.resolveContextLink
                  )
              ),
        input.text === '' ? '' : toRichMarkdown(input.text, { streaming: true }),
    ]);

export interface RichReplyBodyInput {
    /** The model's answer as stored (raw markdown) */
    readonly text: string;
    /** The thinking shown as a collapsed quote; undefined when it lives behind the link message */
    readonly thinking?: string;
    readonly groundingData?: GroundingData[];
    /** The search footer, built once for the fold decision */
    readonly googleSearch: GoogleSearchDocument;
    readonly agentStats?: AgentStats;
    readonly wasStoppedByUser: boolean;
    /** The footer went to the search link message: the body leaves it out */
    readonly searchFolded: boolean;
    readonly resolveContextLink?: ContextLinkResolver;
}

/** Whether a footer document shows anything at all (an empty one is never folded either) */
export const searchFooterPresent = (document: GoogleSearchDocument): boolean =>
    renderGoogleSearchFooter(document).text.trim() !== '';

/**
 * The final body: thinking quote, answer, [stopped], tool records, inline
 * search footer, in the order the entities layout shows them. null for a reply
 * without answer text (media only, thinking only, empty): the entities path
 * owns those.
 */
export const buildRichReplyBody = (input: RichReplyBodyInput): string | null => {
    if (input.text.trim() === '') return null;
    const linkify = (message: RenderedMessage): RenderedMessage =>
        linkifyContextNumbers(message, input.resolveContextLink);
    const groundingData = input.groundingData ?? [];
    const searchGrounding = groundingData.find(isSearchGroundingStep);
    const footer = renderGoogleSearchFooter(input.googleSearch);
    const inlineFooter = !input.searchFolded && footer.text.trim() !== '';
    return joinRichBlocks([
        thinkingQuoteBlock(input.thinking, input.resolveContextLink),
        toRichMarkdown(withCitations(input.text, searchGrounding), { streaming: true }),
        input.wasStoppedByUser ? toRichHtml(plainText('[stopped]')) : '',
        ...buildToolRecordSections(input.agentStats, groundingData).map((section) => toRichHtml(linkify(section))),
        inlineFooter ? toRichHtml(linkify(footer)) : '',
    ]);
};

export interface RichErrorDisplayInput {
    /** The partial answer streamed before the error */
    readonly text: string;
    /** The partial thinking for the quote; undefined on a continuation */
    readonly thinking?: string;
    /** The error line (with the kept-rounds line), rendered as the entities display renders it */
    readonly errorLines: RenderedMessage;
    readonly resolveContextLink?: ContextLinkResolver;
}

/** What survived the failure, then the italic error lines */
export const buildRichErrorDisplay = (input: RichErrorDisplayInput): string =>
    joinRichBlocks([
        thinkingQuoteBlock(input.thinking, input.resolveContextLink),
        input.text === '' ? '' : toRichMarkdown(input.text, { streaming: true }),
        toRichHtml(input.errorLines),
    ]);
