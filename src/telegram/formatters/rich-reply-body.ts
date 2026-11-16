/**
 * The reply body as one Telegram rich message (the chat's richReplies switch).
 *
 * Only the model's answer goes as markdown (`toRichMarkdown`): that is where
 * the native tables, headings and math come from, and its `#N` context
 * references become links there (`textLinks`). Everything the bot builds
 * itself — the thinking quote, the [stopped] marker, the tool records, the
 * search footer, the status and error lines — is already an exact
 * {text, entities} message and goes as HTML blocks (`toRichHtml`), so no
 * runtime string is ever re-escaped as markdown.
 *
 * An answer may embed pictures (`![图注](g1)` on a paragraph of its own). The
 * delivery scans them out first (`rich-inline-media/scan.ts`): the answer's
 * clean text is what everything else sees, and the assembly text with its
 * sentinels is this module's input, where each sentinel becomes a media block
 * (`rich-inline-media/media-blocks.ts`).
 *
 * Blocks follow the answer (the status line, [stopped], tool records, the
 * footer, the error line), so the answer must not leave a construct open over
 * them: see answerMarkdown.
 */
import { renderMarkdown, toRichHtml, toRichMarkdown } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { AgentStats, GroundingData } from '../../ai/types.js';
import { contextTextLinker, linkifyContextNumbers, type ContextLinkResolver } from './context-links.js';
import { plainText } from './entity-text.js';
import { withCitations } from './final-message-builder.js';
import { headEndOf } from './rich-answer-cut.js';
import {
    isSearchGroundingStep,
    renderGoogleSearchFooter,
    type GoogleSearchDocument,
} from './google-search-document.js';
import { renderThinkingQuote } from './quoted-render.js';
import { joinRichBlocks } from './rich-blocks.js';
import {
    combineRichBodyLengths,
    estimateRenderedMessage,
    type RichBodyLength,
} from './rich-body-length.js';
import { replaceMediaSentinels, type RichInlineMedia } from './rich-inline-media/media-blocks.js';
import { stripInlineMarkersForDisplay } from './rich-inline-media/scan.js';
import { formatThinkingForStreaming } from './thinking-display.js';
import { buildToolRecordSections } from './tool-records-formatter.js';

/** The collapsed thinking quote of a final or error display, before HTML serialization */
const thinkingQuoteMessage = (
    thinking: string | undefined,
    resolveContextLink?: ContextLinkResolver
): RenderedMessage | undefined =>
    thinking === undefined || thinking === ''
        ? undefined
        : linkifyContextNumbers(renderThinkingQuote(thinking, { expandable: true }), resolveContextLink);

/** The collapsed thinking quote of a final or error display */
const thinkingQuoteBlock = (thinking: string | undefined, resolveContextLink?: ContextLinkResolver): string => {
    const message = thinkingQuoteMessage(thinking, resolveContextLink);
    return message === undefined ? '' : toRichHtml(message);
};

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
 * The answer as rich markdown that the blocks after it cannot fall into, its
 * `#N` references linked. A streaming frame prefers the streaming form (what
 * is still being typed shows as intended); a final or error display prefers
 * the strict form, the way the entities final reads the answer. The other
 * form is taken when the preferred one leaves a construct open over what
 * follows: a cut answer ending inside a top-level fence needs the streaming
 * close, while telegram-md-entities 0.8.0 closes a fence nested in a list
 * item at column 0, which opens a new fence, so there only the strict form
 * keeps the following blocks outside.
 */
const answerMarkdown = (
    text: string,
    preferred: 'streaming' | 'strict',
    resolveContextLink: ContextLinkResolver | undefined
): string => {
    const textLinks = contextTextLinker(resolveContextLink);
    const streamingForm = (): string => toRichMarkdown(text, { streaming: true, textLinks });
    const strictForm = (): string => toRichMarkdown(text, { textLinks });
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
    /**
     * The reply may embed pictures: a marker's paragraph is hidden in the frame
     * (the pictures appear when the final is written). Off keeps a public
     * picture URL as today, and only hides internal ids.
     */
    readonly inlineImagesEnabled?: boolean;
}

/** One streaming frame without the status line (the streaming editor appends it) */
export const buildRichStreamingFrame = (input: RichStreamingFrameInput): string => {
    // A marker the model is still writing must not reach the frame
    const text = stripInlineMarkersForDisplay(input.text, { embed: input.inlineImagesEnabled === true });
    return joinRichBlocks([
        input.thinking === ''
            ? ''
            : toRichHtml(
                  linkifyContextNumbers(
                      formatThinkingForStreaming(input.thinking, { answerStarted: input.answerStarted }),
                      input.resolveContextLink
                  )
              ),
        text === '' ? '' : answerMarkdown(text, 'streaming', input.resolveContextLink),
    ]);
};

export interface RichAnswerInput {
    /** The answer as stored: the model's markdown, markers included */
    readonly text: string;
    readonly groundingData?: readonly GroundingData[];
    readonly resolveContextLink?: ContextLinkResolver;
    /** The pictures the body embeds: each scanned sentinel becomes a media block */
    readonly inlineMedia?: readonly RichInlineMedia[];
}

/**
 * The answer section as rich markdown: the citations, the `#N` links, and the
 * media blocks in place of the sentinels. This is the snapshot a version keeps
 * (the replay puts it into the body as it is, without rendering it again).
 */
export const buildRichAnswer = (input: RichAnswerInput): string => {
    const searchGrounding = (input.groundingData ?? []).find(isSearchGroundingStep);
    const markdown = answerMarkdown(withCitations(input.text, searchGrounding), 'strict', input.resolveContextLink);
    return replaceMediaSentinels(markdown, input.inlineMedia ?? []);
};

export interface RichReplyBodyInput {
    /** The model's answer as stored (raw markdown; the assembly text when it embeds pictures) */
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
    /** The pictures the body embeds (empty for a reply without inline pictures) */
    readonly inlineMedia?: readonly RichInlineMedia[];
}

/** Whether a footer document shows anything at all (an empty one is never folded either) */
export const searchFooterPresent = (document: GoogleSearchDocument): boolean =>
    renderGoogleSearchFooter(document).text.trim() !== '';

/**
 * The blocks around the answer: [stopped], the tool records, the inline search
 * footer. Live and replay build them the same way, from the same inputs.
 */
const bodyBlockMessages = (
    input: RichReplyBodyFromAnswerInput,
    linkify: (message: RenderedMessage) => RenderedMessage
): readonly RenderedMessage[] => {
    const groundingData = input.groundingData ?? [];
    const footer = renderGoogleSearchFooter(input.googleSearch);
    const inlineFooter = !input.searchFolded && footer.text.trim() !== '';
    return [
        ...(input.wasStoppedByUser ? [plainText('[stopped]')] : []),
        ...buildToolRecordSections(input.agentStats, groundingData).map((section) => linkify(section)),
        ...(inlineFooter ? [linkify(footer)] : []),
    ];
};

export interface RichReplyBodyFromAnswerInput {
    /**
     * The answer section as the body shows it, already rendered (citations,
     * `#N` links and media blocks in place). A replay must pass the stored
     * snapshot: rendering it again would change it.
     */
    readonly answerMarkdown: string;
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

/**
 * A final body before composition: the thinking quote, the answer section and
 * the blocks after it. The delivery both composes the body from this and
 * measures it (the fold decision), so the two always read the same sources.
 */
export interface RichReplyBodyParts {
    /** The collapsed thinking quote; undefined when the thinking lives behind the link */
    readonly thinking?: RenderedMessage;
    readonly answerMarkdown: string;
    /** [stopped], the tool records, the inline search footer, in layout order */
    readonly blocks: readonly RenderedMessage[];
}

/**
 * The parts of a final body built around an already rendered answer section.
 * null when the body would be empty (no answer text): the entities path owns
 * those.
 */
export const richReplyBodyPartsOf = (input: RichReplyBodyFromAnswerInput): RichReplyBodyParts | null => {
    if (input.answerMarkdown.trim() === '') return null;
    const linkify = (message: RenderedMessage): RenderedMessage =>
        linkifyContextNumbers(message, input.resolveContextLink);
    const thinking = thinkingQuoteMessage(input.thinking, input.resolveContextLink);
    return {
        ...(thinking === undefined ? {} : { thinking }),
        answerMarkdown: input.answerMarkdown,
        blocks: bodyBlockMessages(input, linkify),
    };
};

/** The body markdown of its parts, in the order the entities layout shows them */
export const joinRichReplyBodyParts = (parts: RichReplyBodyParts): string =>
    joinRichBlocks([
        parts.thinking === undefined ? '' : toRichHtml(parts.thinking),
        parts.answerMarkdown,
        ...parts.blocks.map((block) => toRichHtml(block)),
    ]);

/**
 * The final body built around an already rendered answer section. Live (from
 * buildRichAnswer) and replay (from the stored snapshot) share this, so a
 * version shows exactly what the reply showed.
 */
export const buildRichReplyBodyFromAnswer = (input: RichReplyBodyFromAnswerInput): string | null => {
    const parts = richReplyBodyPartsOf(input);
    return parts === null ? null : joinRichReplyBodyParts(parts);
};

/**
 * Fold-length estimate of a body, from the same parts the body is composed of.
 * The caller passes the answer section's own length, which it may cache: the
 * answer section is the expensive parse and usually the same for two candidate
 * bodies (with and without the thinking quote).
 */
export const measureRichReplyBodyParts = (
    parts: RichReplyBodyParts,
    answerLength: RichBodyLength
): RichBodyLength =>
    combineRichBodyLengths([
        answerLength,
        ...(parts.thinking === undefined ? [] : [estimateRenderedMessage(parts.thinking)]),
        ...parts.blocks.map((block) => estimateRenderedMessage(block)),
    ]);

/**
 * The final body from the raw answer (the live path): the answer is rendered
 * here, then the blocks around it are added by buildRichReplyBodyFromAnswer.
 * null for a reply without answer text and without embedded pictures (media
 * only, thinking only, empty): the entities path owns those.
 */
export const buildRichReplyBody = (input: RichReplyBodyInput): string | null => {
    if (input.text.trim() === '' && (input.inlineMedia?.length ?? 0) === 0) return null;
    return buildRichReplyBodyFromAnswer({
        answerMarkdown: buildRichAnswer({
            text: input.text,
            ...(input.groundingData === undefined ? {} : { groundingData: input.groundingData }),
            ...(input.resolveContextLink === undefined ? {} : { resolveContextLink: input.resolveContextLink }),
            ...(input.inlineMedia === undefined ? {} : { inlineMedia: input.inlineMedia }),
        }),
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
        ...(input.groundingData === undefined ? {} : { groundingData: input.groundingData }),
        googleSearch: input.googleSearch,
        ...(input.agentStats === undefined ? {} : { agentStats: input.agentStats }),
        wasStoppedByUser: input.wasStoppedByUser,
        searchFolded: input.searchFolded,
        ...(input.resolveContextLink === undefined ? {} : { resolveContextLink: input.resolveContextLink }),
    });
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
    /** The reply may embed pictures: its half-written markers are hidden too */
    readonly inlineImagesEnabled?: boolean;
}

/** The paragraph that stands for the end of an answer the error display cut */
const CUT_MARK_BLOCK = toRichHtml(plainText('…'));

/** Passes the cut gets before the display falls back to the error lines alone */
const MAX_CUT_PASSES = 8;

/** Cut this much more than the overflow, so that one pass usually settles it */
const CUT_MARGIN = 500;

/** A link textLinks put on a `#N` (or one the answer wrote the same way) */
const CONTEXT_ANCHOR = /<a href="[^"]*">#\d{1,3}<\/a>/g;

const contextAnchorsOf = (markdown: string): string[] => markdown.match(CONTEXT_ANCHOR) ?? [];

/**
 * The cut head as rich markdown. A cut can make a `#N` that the whole answer
 * shows as text into a link: in a code span, a link label or a formula it
 * cut open, or glued to what it cut off ('#12**x**' reads '#12x'). The
 * head's links are then no longer the first links of the whole answer, and
 * the head goes without links.
 */
const cutHeadMarkdown = (
    head: string,
    resolveContextLink: ContextLinkResolver | undefined,
    wholeAnchors: readonly string[]
): string => {
    const linked = answerMarkdown(head, 'strict', resolveContextLink);
    const anchors = contextAnchorsOf(linked);
    const onlyLinksOfTheWhole =
        anchors.length <= wholeAnchors.length && anchors.every((anchor, index) => anchor === wholeAnchors[index]);
    return onlyLinksOfTheWhole ? linked : answerMarkdown(head, 'strict', undefined);
};

/**
 * The answer's head with a '…' paragraph, then the error lines, within
 * maxLength (where the head ends: headEndOf). The rendered answer is longer
 * than its source (tags, and about 45 characters per `#N` link), so a pass
 * cuts what the last one was over by, scaled back to source characters, plus
 * a margin. The first pass scales by the whole answer's ratio, later ones by
 * what the last cut took off: when the links bunch at the top, the average
 * overstates what lies right before the cut. That ratio can be far off the
 * other way too, so a later pass keeps at least half of the head.
 */
const cutAnswerToFit = (
    input: RichErrorDisplayInput,
    errorBlock: string,
    uncut: { readonly displayLength: number; readonly answerBlock: string }
): string => {
    const { maxLength, resolveContextLink } = input;
    const wholeAnchors = contextAnchorsOf(uncut.answerBlock);
    let head = input.text;
    let renderedHeadLength = uncut.answerBlock.length;
    let overflow = uncut.displayLength - maxLength;
    let renderedPerSourceCharacter = renderedHeadLength / Math.max(1, head.length);
    for (let pass = 0; pass < MAX_CUT_PASSES && head !== ''; pass += 1) {
        const estimate = head.length - Math.ceil(overflow / Math.max(1, renderedPerSourceCharacter)) - CUT_MARGIN;
        const target = pass === 0 ? estimate : Math.max(estimate, Math.floor(head.length / 2));
        // Trailing blank lines and spaces of the head belong to the cut
        const cutHead = target <= 0 ? '' : head.slice(0, headEndOf(head, target)).trimEnd();
        const answerBlock = cutHead === '' ? '' : cutHeadMarkdown(cutHead, resolveContextLink, wholeAnchors);
        const display = joinRichBlocks([answerBlock, CUT_MARK_BLOCK, errorBlock]);
        if (display.length <= maxLength) return display;
        // The cut took at least a character off: the target is below the head's length
        renderedPerSourceCharacter = (renderedHeadLength - answerBlock.length) / (head.length - cutHead.length);
        overflow = display.length - maxLength;
        renderedHeadLength = answerBlock.length;
        head = cutHead;
    }
    return joinRichBlocks([CUT_MARK_BLOCK, errorBlock]);
};

/**
 * What survived the failure, then the italic error lines. Over maxLength the
 * thinking quote goes first, then the end of the answer (see cutAnswerToFit).
 * Display only: the stored version keeps the whole text. A half-written picture
 * marker (the failure can interrupt the model mid-marker) is hidden like in the
 * frames.
 */
export const buildRichErrorDisplay = (input: RichErrorDisplayInput): string => {
    const text = stripInlineMarkersForDisplay(input.text, { embed: input.inlineImagesEnabled === true });
    const quoteBlock = thinkingQuoteBlock(input.thinking, input.resolveContextLink);
    const answerBlock = text === '' ? '' : answerMarkdown(text, 'strict', input.resolveContextLink);
    const errorBlock = toRichHtml(input.errorLines);
    const whole = joinRichBlocks([quoteBlock, answerBlock, errorBlock]);
    if (whole.length <= input.maxLength) return whole;
    const withoutQuote = joinRichBlocks([answerBlock, errorBlock]);
    if (withoutQuote.length <= input.maxLength) return withoutQuote;
    const uncut = { displayLength: joinRichBlocks([answerBlock, CUT_MARK_BLOCK, errorBlock]).length, answerBlock };
    return cutAnswerToFit({ ...input, text }, errorBlock, uncut);
};
