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
 * Blocks follow the answer (the status line, [stopped], tool records, the
 * footer, the error line), so the answer must not leave a construct open over
 * them: see answerMarkdown.
 */
import { renderMarkdown, toRichHtml, toRichMarkdown } from 'telegram-md-entities';
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

/** A paragraph standing in for the blocks that follow the answer */
const TAIL_PROBE = 'rich-tail-probe';

const COVERING_ENTITY_TYPES: ReadonlySet<string> = new Set(['pre', 'code', 'blockquote', 'expandable_blockquote']);

/**
 * Whether a block placed after this markdown would land inside one of its
 * constructs (an open code fence, an open <details>). The package's CommonMark
 * parser reads the document as Telegram's GFM-based parser does here.
 */
const swallowsFollowingBlocks = (markdown: string): boolean => {
    const rendered = renderMarkdown(`${markdown}\n\n${TAIL_PROBE}`);
    const probeAt = rendered.text.lastIndexOf(TAIL_PROBE);
    return (
        probeAt === -1 ||
        rendered.entities.some(
            (entity) =>
                COVERING_ENTITY_TYPES.has(entity.type) &&
                entity.offset <= probeAt &&
                probeAt < entity.offset + entity.length
        )
    );
};

/**
 * The answer as rich markdown that the blocks after it cannot fall into. A
 * streaming frame prefers the streaming form (what is still being typed shows
 * as intended); a final or error display prefers the strict form, the way the
 * entities final reads the answer. The other form is taken when the preferred
 * one leaves a construct open over what follows: a cut answer ending inside a
 * top-level fence needs the streaming close, while telegram-md-entities 0.8.0
 * closes a fence nested in a list item at column 0, which opens a new fence,
 * so there only the strict form keeps the following blocks outside.
 */
const answerMarkdown = (text: string, preferred: 'streaming' | 'strict'): string => {
    const streamingForm = (): string => toRichMarkdown(text, { streaming: true });
    const strictForm = (): string => toRichMarkdown(text);
    const first = preferred === 'streaming' ? streamingForm() : strictForm();
    if (!swallowsFollowingBlocks(first)) return first;
    const second = preferred === 'streaming' ? strictForm() : streamingForm();
    return swallowsFollowingBlocks(second) ? first : second;
};

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
        input.text === '' ? '' : answerMarkdown(input.text, 'streaming'),
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
        answerMarkdown(withCitations(input.text, searchGrounding), 'strict'),
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
    /** The longest display (markdown source length) the caller can send */
    readonly maxLength: number;
}

/** The paragraph that stands for the end of an answer the error display cut */
const CUT_MARK_BLOCK = toRichHtml(plainText('…'));

/** Passes the cut gets before the display falls back to the error lines alone */
const MAX_CUT_PASSES = 8;

/** Cut this much more than the overflow, so that one pass usually settles it */
const CUT_MARGIN = 500;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Where the head of text ends when it may be at most target long: the last
 * paragraph boundary, else the last line break, else target itself (never
 * between the halves of a surrogate pair). A boundary in the first half is
 * passed over: it would drop most of what is left. A plain search on
 * purpose: the construct-aware raw splitter is quadratic on tables and code
 * blocks, and answerMarkdown already closes what a cut leaves open.
 */
const headEndOf = (text: string, target: number): number => {
    const floor = Math.floor(target / 2);
    const paragraphEnd = text.lastIndexOf('\n\n', target);
    if (paragraphEnd > floor) return paragraphEnd;
    const lineEnd = text.lastIndexOf('\n', target);
    if (lineEnd > floor) return lineEnd;
    return isHighSurrogate(text.charCodeAt(target - 1)) ? target - 1 : target;
};

/**
 * The answer's head with a '…' paragraph, then the error lines, within
 * maxLength. The rendered answer runs about as long as its source, so each
 * pass cuts what the last one was over by, plus a margin.
 */
const cutAnswerToFit = (text: string, errorBlock: string, uncutLength: number, maxLength: number): string => {
    let head = text;
    let overflow = uncutLength - maxLength;
    for (let pass = 0; pass < MAX_CUT_PASSES && head !== ''; pass += 1) {
        const target = head.length - overflow - CUT_MARGIN;
        // Trailing blank lines and spaces of the head belong to the cut
        head = target <= 0 ? '' : head.slice(0, headEndOf(head, target)).trimEnd();
        const display = joinRichBlocks([head === '' ? '' : answerMarkdown(head, 'strict'), CUT_MARK_BLOCK, errorBlock]);
        if (display.length <= maxLength) return display;
        overflow = display.length - maxLength;
    }
    return joinRichBlocks([CUT_MARK_BLOCK, errorBlock]);
};

/**
 * What survived the failure, then the italic error lines. Over maxLength the
 * thinking quote goes first, then the end of the answer (see cutAnswerToFit).
 * Display only: the stored version keeps the whole text.
 */
export const buildRichErrorDisplay = (input: RichErrorDisplayInput): string => {
    const quoteBlock = thinkingQuoteBlock(input.thinking, input.resolveContextLink);
    const answerBlock = input.text === '' ? '' : answerMarkdown(input.text, 'strict');
    const errorBlock = toRichHtml(input.errorLines);
    const whole = joinRichBlocks([quoteBlock, answerBlock, errorBlock]);
    if (whole.length <= input.maxLength) return whole;
    const withoutQuote = joinRichBlocks([answerBlock, errorBlock]);
    if (withoutQuote.length <= input.maxLength) return withoutQuote;
    const uncutLength = joinRichBlocks([answerBlock, CUT_MARK_BLOCK, errorBlock]).length;
    return cutAnswerToFit(input.text, errorBlock, uncutLength, input.maxLength);
};
