/**
 * Context builder for AI chat
 * Builds unified message context from database messages
 */
import { match } from 'ts-pattern';
import type { Message } from '../db/messageDTO.js';
import {
    getContextMessage,
    getFileContentsOfMessage,
    loadWidgetSurfaces,
    toContextMessage,
    type ContextMessage,
    type WidgetSurfaceInfo,
} from '../db/queries/context-queries.js';
import { assembleContextMessages, isSubImage, type ContextNumbering } from './context-assembly.js';
import { getLinkPreviewParts } from '../services/luoxu-preview-service.js';
import {
    getTgMessageLinkPreviewParts,
    planTgMessageLinkPreviews,
    type TgMessageLinkPlan,
} from '../services/tg-message-link-service.js';
import { getBilibiliDanmakuPart } from '../services/bilibili-danmaku-service.js';
import { readStoredChatCommand } from './commands/chat-command-parser.js';
import { buildOcrFallbackPart } from '../services/luoxu-ocr-service.js';
import { applyModelCapabilities } from '../ai/message-transformer.js';
import { buildRuntimeContext } from '../ai/system-prompt/runtime-context.js';
import { getRepliesInFlight, isBotReplyInFlight, setContextNumbering } from '../state.js';
import { getGlobalDefaultModel } from '../services/chat-settings-service.js';
import { replacesChatSystemPrompt } from '../ai/model-kinds.js';
import { buildInFlightOwnReplyNote, buildInFlightReplyNote, buildInterruptedOwnReplyNote } from './inflight-reply-note.js';
import { collectContextUsers, type ContextUser } from './context-users.js';
import { getModelCapabilities } from '../ai/platform-factory.js';
import { buildCustomEmojiContextPlan } from '../services/custom-emoji-context-service.js';
import { contextImagesOf, type ContextImage } from './context-images.js';
import { dedupeContextMedia, type MediaDedupeInput } from './media-dedupe.js';
import type { ContextIndex, ContextIndexEntry } from './context-index.js';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types.js';

// The side-effect-free half of buildContext, shared with the panel's tree view
export {
    assembleContextMessages,
    type AssembleContextOptions,
    type AssembledContext,
    type ContextNumbering,
} from './context-assembly.js';

/** Sticker kinds as recorded by autoSave when the media was captured */
const STICKER_KINDS = new Set(['sticker', 'video_sticker', 'animated_sticker', 'animated_sticker_still']);
/** Stickers that are short video clips rather than a single still frame */
const ANIMATED_STICKER_KINDS = new Set(['video_sticker', 'animated_sticker']);

/** One-line excerpt caps for the header annotations */
const REPLY_EXCERPT_CHARS = 40;
const QUOTE_EXCERPT_CHARS = 300;

/**
 * Cap on one replayed A2UI surface. A card's source is replayed so a later turn
 * can revise it, not to be re-read whole; bigger surfaces are cut and marked.
 */
const A2UI_SURFACE_MAX_CHARS = 4000;
const A2UI_SURFACE_TRUNCATED_MARK = '…（已截断）';

/** What a reply to an excluded or unknown message reads as */
const UNSEEN_REPLY_TARGET = '[replying to a message you cannot see]';

const isSticker = (part: UnifiedContentPart): boolean =>
    Boolean(part.mediaKind && STICKER_KINDS.has(part.mediaKind));

const isAnimatedSticker = (part: UnifiedContentPart): boolean =>
    Boolean(part.mediaKind && ANIMATED_STICKER_KINDS.has(part.mediaKind));

/**
 * The words a message carries. Rows older than the header change kept the
 * `<<EOF` marker inside their text, so it is stripped before deciding whether
 * a message says anything at all.
 */
const bodyTextOf = (msg: ContextMessage): string =>
    (msg.text ?? '').replace(/<<EOF\s*$/, '').trim();

/**
 * One stored media hint reduced to the short form a reply annotation names.
 * Bot rows carry the short 'sticker', user rows the longer hints (and
 * backfilled rows the recovered-history wording).
 */
const MEDIUM_LABELS: ReadonlyArray<readonly [string, string]> = [
    ['sticker', 'a sticker'],
    ['a sticker', 'a sticker'],
    ['an animated sticker', 'a sticker'],
    ['a picture', 'a picture'],
    ['some pictures', 'some pictures'],
    ['a file: ', 'a file'],
    ['a widget', 'a widget'],
    ['a video note', 'a video note'],
    ['a video', 'a video'],
    ['an animation', 'an animation'],
    ['a voice message', 'a voice message'],
    ['an audio file', 'an audio file'],
];

const mediumLabelOf = (hint: string | null): string | undefined =>
    hint === null
        ? undefined
        : MEDIUM_LABELS.find(([prefix]) => hint === prefix || hint.startsWith(prefix))?.[1];

/**
 * The medium a reply annotation names, if any. A user message is a single
 * Telegram message, so a caption belongs to its photo or file: what the reply
 * answers is still that medium. Our own replies span two messages (text first,
 * attachment second), so only a reply with no words of its own is answered by
 * its medium — naming the sticker there would hide the words.
 */
const replyMediumOf = (msg: ContextMessage): string | undefined => {
    if (msg.fromBotSelf && bodyTextOf(msg)) return undefined;
    return mediumLabelOf(msg.mediaHint);
};

/** Audio/visual media kinds present in the parts, for a type-specific nudge */
const audioVisualKinds = (parts: UnifiedContentPart[]): Array<'video' | 'audio'> => {
    const kinds = new Set<'video' | 'audio'>();
    for (const part of parts) {
        if (part.type !== 'media') continue;
        if (part.mimeType?.startsWith('video/')) kinds.add('video');
        if (part.mimeType?.startsWith('audio/')) kinds.add('audio');
    }
    return [...kinds];
};

// Models tend to reply from the surrounding text and skip attached video/audio,
// and to repeat the same description in every following reply.
const buildAudioVisualNudge = (kinds: Array<'video' | 'audio'>): string => {
    const noun = kinds.join(' and ');
    return `[system] A ${noun} file is attached to this message and visible to you.`;
};

// Sticker clips are tone, not content: describing them is optional, and the
// description must not be repeated in every following reply.
const ANIMATED_STICKER_NUDGE =
    '[system] The attached sticker is a short video clip — play it through to know what it really shows.';

// The pack emoji rides along in the media hint but says little about the artwork.
const STICKER_EMOJI_NUDGE =
    "[system] A sticker's pack emoji is loose metadata often assigned automatically by Telegram and may be unrelated to the actual image/clip.";

/** Whether one content part survives the model's capability filter */
const partVisibleToModel = (
    part: UnifiedContentPart,
    capabilities: ModelCapabilities
): boolean =>
    match(part.type)
        .with('image', () => capabilities.supportsImageInput)
        .with('media', () => capabilities.supportsMediaInput)
        .with('text', () => true)
        .exhaustive();

/** Whether every attached media part survives the model's capability filter */
const mediaVisibleToModel = (
    mediaParts: UnifiedContentPart[],
    capabilities: ModelCapabilities
): boolean =>
    mediaParts.length > 0 &&
    mediaParts.every((part) => partVisibleToModel(part, capabilities));

/**
 * `[system]` nudges for one message's attachments. Computed from the parts the
 * model will actually receive, so a filtered-out attachment never gets a nudge
 * that talks about media the model cannot see.
 */
const buildMediaNudges = (visibleParts: UnifiedContentPart[]): string[] => {
    const nudges: string[] = [];

    // Plain video/audio files: a concrete description of the real content is required.
    // Sticker clips are excluded — they get their own, softer nudge below.
    const kinds = audioVisualKinds(visibleParts.filter((part) => !isAnimatedSticker(part)));
    if (kinds.length) {
        nudges.push(buildAudioVisualNudge(kinds));
    }

    if (visibleParts.some(isAnimatedSticker)) {
        nudges.push(ANIMATED_STICKER_NUDGE);
    }
    if (visibleParts.some(isSticker)) {
        nudges.push(STICKER_EMOJI_NUDGE);
    }

    return nudges;
};

/** Collapse to a single line and cap by codepoints (avoids breaking emoji) */
const oneLineExcerpt = (text: string, maxChars: number): string => {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const chars = Array.from(collapsed);
    return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : collapsed;
};

/**
 * Publish `#N → messageId` for the display layer, which turns the `#N` the
 * model writes back into clickable message links. Display-only: the reply that
 * gets persisted keeps the plain numbers.
 *
 * A bot reply split across several Telegram messages is stored under its
 * firstMessageId alone (see session.finalize), so the number maps to the first
 * message of the reply — which is exactly where the link should land.
 */
const publishContextNumbering = (
    chatId: number,
    userMessageId: number,
    index: ContextNumbering
): void => {
    const messageIdOf = new Map<number, number>();
    for (const [messageId, contextNumber] of index.numberOf) {
        messageIdOf.set(contextNumber, messageId);
    }
    setContextNumbering(chatId, userMessageId, messageIdOf);
};

/**
 * Render `[replying to …]` for one reply target: by context number when the
 * target is in the context, otherwise by a short excerpt of it. An excluded
 * target is never quoted: the model only learns that something it cannot see
 * was answered.
 */
const renderReplyTarget = async (
    chatId: number,
    replyToId: number,
    index: ContextNumbering,
    exclusions: ReadonlySet<number>
): Promise<string> => {
    const target = index.byId.get(replyToId);

    if (target) {
        const targetNumber = index.numberOf.get(replyToId);
        // Telegram lets a user swipe-reply to any message, including a sticker
        // it merely scrolled past: state the medium, infer nothing from it.
        const medium = replyMediumOf(target);
        const mediumNote = medium ? ` (${medium})` : '';
        return target.fromBotSelf
            ? `[replying to your reply #${targetNumber}${mediumNote}]`
            : `[replying to #${targetNumber} ${target.userName}${mediumNote}]`;
    }

    if (exclusions.has(replyToId)) return UNSEEN_REPLY_TARGET;
    const replyMsg = await getContextMessage(chatId, replyToId);
    // A continuation id resolves to its reply's first message, the excluded id
    if (replyMsg && exclusions.has(replyMsg.messageId)) return UNSEEN_REPLY_TARGET;
    if (replyMsg && isSubImage(replyMsg)) {
        return `[replying to one of ${replyMsg.userName}'s attached media]`;
    }
    // Out of the context the words are the only clue: quote them rather than
    // naming the medium the words belong to.
    const replyText = replyMsg ? bodyTextOf(replyMsg) : '';
    if (replyMsg && replyText) {
        return `[replying to ${replyMsg.userName}: "${oneLineExcerpt(replyText, REPLY_EXCERPT_CHARS)}"]`;
    }
    const medium = replyMsg ? mediumLabelOf(replyMsg.mediaHint) : undefined;
    if (replyMsg && medium) {
        return `[replying to ${replyMsg.userName}: ${medium}]`;
    }
    return UNSEEN_REPLY_TARGET;
};

/**
 * `/chat <link>` spliced other conversations in without asking for a reply. The
 * linked messages are in the context whenever their conversation came along,
 * so `#N` tells the model which stretch was brought in; a link that could not
 * be followed at build time gets the vague form.
 */
const renderLinkedConversationAnnotation = (
    linkedMessageIds: number[],
    index: ContextNumbering
): string => {
    const numbers = linkedMessageIds
        .map((messageId) => index.numberOf.get(messageId))
        .filter((number): number is number => number !== undefined);
    if (!numbers.length) return '[attached another conversation to the context]';
    return `[attached the conversation around ${numbers.map((number) => `#${number}`).join(', ')} to the context]`;
};

/**
 * Render the annotation of a `/chat` summon, which replaces `[replying to …]`:
 * the reply was only how the user picked a starting point, not something they
 * were answering.
 *
 * When the target sits mid-context, `#N` is the useful part — it tells the model
 * which stretch of the context the user pulled in by hand. When the target *is*
 * the start of the context (`#1`, by far the common case), "the messages after
 * #1" describes the whole context and says nothing, so it collapses to a plain
 * summon.
 */
const renderChatCommandAnnotation = (
    msg: ContextMessage,
    index: ContextNumbering
): string | null => {
    const stored = readStoredChatCommand(msg.chatCommand ?? '');
    if (stored.mode === 'link') {
        return renderLinkedConversationAnnotation(stored.linkedMessageIds, index);
    }

    const targetNumber = msg.replyToId === null ? undefined : index.numberOf.get(msg.replyToId);
    const pulledInPart = targetNumber !== undefined && targetNumber > 1;
    const hasWords = Boolean(msg.text?.trim());

    if (pulledInPart) {
        // Without words of their own the annotation is the whole message, so it
        // has to say what the user wants, not just what they did
        const summons = hasWords ? '' : ', and summons you to reply';
        return `[added the messages after #${targetNumber} to the context${summons}]`;
    }

    // The target starts the context: nothing to point at. A summon with words of
    // its own is then indistinguishable from an ordinary message — say nothing.
    return hasWords ? null : '[summons you to reply based on the current context]';
};

/**
 * Build reply annotations for one message,
 * e.g. `[replying to #2 某某]` and `[quote: "引文"]`.
 */
const buildReplyAnnotations = async (
    msg: ContextMessage,
    index: ContextNumbering,
    exclusions: ReadonlySet<number>
): Promise<string[]> => {
    const annotations: string[] = [];

    if (msg.chatCommand) {
        // A /chat summon describes itself; it is never "replying to" its target
        const annotation = renderChatCommandAnnotation(msg, index);
        if (annotation) annotations.push(annotation);
    } else if (msg.replyToId) {
        annotations.push(await renderReplyTarget(msg.chatId, msg.replyToId, index, exclusions));
    }

    if (msg.quoteText) {
        annotations.push(`[quote: "${oneLineExcerpt(msg.quoteText, QUOTE_EXCERPT_CHARS)}"]`);
    }

    return annotations;
};

/**
 * The square-bracket annotations of a user message's header, in header order:
 * forward origin, inline bot, reply context, attached media.
 */
const headerAnnotationsOf = (
    msg: ContextMessage,
    replyAnnotations: string[],
    mediaVisible: boolean
): string[] => {
    const annotations: string[] = [];
    if (msg.forwardOrigin) {
        annotations.push(`[forwarded from ${msg.forwardOrigin}]`);
    }
    if (msg.viaBot) {
        annotations.push(`[via inline bot ${msg.viaBot}]`);
    }
    annotations.push(...replyAnnotations);
    if (msg.mediaHint) {
        // A `/chat r` video is here for its words only; a failure hint already
        // says "you cannot see it" and must not collect a second suffix
        const hint =
            msg.mediaOmitted && !msg.mediaHint.includes('you cannot see it')
                ? `${msg.mediaHint} — not included in this context, you cannot see it`
                : msg.mediaHint;
        // failure hints already end with "you cannot see it" — don't double up
        const invisible = !mediaVisible && !hint.includes('you cannot see it');
        annotations.push(`[sent ${hint}${invisible ? ' — not visible to you' : ''}]`);
    }
    return annotations;
};

/**
 * Render the model-facing header: `#N 用户名 [annotation…]`, without the colon.
 * All metadata (context number, forward origin, reply context, attached media)
 * becomes a prefix / square-bracket annotations after the name. The colon is
 * added by renderUserText, and only when there is a body to follow it.
 */
const renderMessageHeader = (
    msg: ContextMessage,
    contextNumber: number | undefined,
    replyAnnotations: string[],
    mediaVisible: boolean
): string => {
    const annotations = headerAnnotationsOf(msg, replyAnnotations, mediaVisible);
    const numberPrefix = contextNumber === undefined ? '' : `#${contextNumber} `;
    return `${numberPrefix}${msg.userName}${annotations.length ? ' ' + annotations.join(' ') : ''}`;
};

/**
 * The header annotations of one user message as the model reads them in the
 * given context, for the panel's tree view. Media are taken as visible: the
 * tree is not built for one model and never loads media bytes.
 */
export const describeMessageAnnotations = async (
    msg: ContextMessage,
    context: { numbering: ContextNumbering; exclusions: ReadonlySet<number> }
): Promise<string[]> =>
    headerAnnotationsOf(msg, await buildReplyAnnotations(msg, context.numbering, context.exclusions), true);

/**
 * Assemble the text part of a user message: header + content + EOF marker.
 *
 * The colon appears only when a body follows it, so a message that carries no
 * text of its own (a sticker, or a `/chat` summon whose annotation *is* its
 * content) reads as a complete line instead of trailing off after `用户名: `.
 * Legacy rows (<= 7 days old) already carry `<<EOF` inside the stored text;
 * those keep their body verbatim.
 */
const renderUserText = (header: string, text: string | null): string => {
    // Whitespace-only is empty: rows stored before this change kept a single
    // space as the body of a `/chat` that carried no words of its own
    const content = text?.trim() ? text : '';
    if (content.includes('<<EOF')) return `${header}: ${content}`;
    return content ? `${header}: ${content}\n<<EOF\n` : `${header}\n<<EOF\n`;
};

/**
 * A stored reply of ours can leak the wire format (`[replying to #2 某某]` or
 * `[#7]` on the first line). Replayed as an example it teaches the model to
 * emit it again — the one thing the format section forbids outright — so those
 * leading lines are stripped whenever our own turn is rebuilt.
 */
const LEAKED_WIRE_FORMAT_LINE = /^[ \t]*(?:\[replying to[^\]\n]*\]|\[#\d+\])[ \t]*\n?/;

export const stripLeakedWireFormat = (text: string): string => {
    let cleaned = text;
    while (LEAKED_WIRE_FORMAT_LINE.test(cleaned)) {
        cleaned = cleaned.replace(LEAKED_WIRE_FORMAT_LINE, '');
    }
    return cleaned.replace(/^\n+/, '');
};

/**
 * The message's own attachments (its file plus album sub-images) as context
 * parts, unfiltered by model capabilities. A message whose media was left out
 * (`/chat r` videos) contributes no part at all — the bytes are never loaded.
 */
const loadMessageFiles = async (msg: ContextMessage): Promise<UnifiedContentPart[]> => {
    if (msg.mediaOmitted) return [];
    return msg.file || msg.fileUniqueId
        ? getFileContentsOfMessage(msg.chatId, msg.messageId)
        : [];
};

/**
 * One assembled turn plus the pictures the model sees in it, in reading order:
 * the message's own attachments first, then the media of its link previews.
 * Tools resolve `#N` image references against this list.
 */
interface BuiltTurn {
    readonly message: UnifiedMessage;
    readonly images: ContextImage[];
}

/**
 * What an assistant turn with no text says.
 *
 * Two different situations reach this point, and the model must be able to tell
 * them apart: a reply that is still streaming (a stored row exists, its text is
 * written at finalize) and one that ended without any text at all. Calling
 * either of them lost made the model believe its own answer had been corrupted.
 */
const missingAssistantText = (
    msg: ContextMessage,
    contextNumber: number | undefined
): string => {
    if (contextNumber === undefined) return '[system] message lost';
    return isBotReplyInFlight(msg.chatId, msg.messageId)
        ? buildInFlightOwnReplyNote(contextNumber)
        : buildInterruptedOwnReplyNote(contextNumber);
};

/**
 * Minified JSON of a stored surface. send_widget accepts either a JSON string
 * or an object, so both shapes reach the database; a string is normalized
 * through JSON.parse so the replay never shows escaped quotes.
 */
const surfaceJsonOf = (surface: unknown): string | null => {
    if (typeof surface === 'string') {
        const trimmed = surface.trim();
        if (!trimmed) return null;
        try {
            return JSON.stringify(JSON.parse(trimmed)) ?? null;
        } catch {
            return trimmed;
        }
    }
    try {
        return JSON.stringify(surface) ?? null;
    } catch {
        return null;
    }
};

/**
 * The `[a2ui surface] …` line replayed right after `[sent a widget]`: the A2UI
 * source the card was built from, so a later turn can revise or reuse it.
 * HTML mode replays no source (size, and the HTML is not worth re-reading).
 */
export const renderA2uiSurfaceNote = (widget: WidgetSurfaceInfo | undefined): string => {
    if (
        widget === undefined ||
        widget.mode !== 'a2ui' ||
        widget.surface === undefined ||
        widget.surface === null
    ) {
        return '';
    }
    const json = surfaceJsonOf(widget.surface);
    if (json === null) return '';
    const chars = Array.from(json);
    const body =
        chars.length > A2UI_SURFACE_MAX_CHARS
            ? `${chars.slice(0, A2UI_SURFACE_MAX_CHARS).join('')}${A2UI_SURFACE_TRUNCATED_MARK}`
            : json;
    return `[a2ui surface] ${body}\n`;
};

/**
 * Build the text turn of one of the bot's own messages: `[#N]`, the fact lines
 * about what the reply carried, and its body. The reply's attachment bytes are
 * never part of this turn — see buildAssistantAttachmentTurn for why.
 *
 * The context number is prefixed as `[#5]` on its own line — deliberately a
 * different shape from the `#5 用户名:` header of user messages, so the model is
 * less tempted to imitate it (the system prompt also forbids it outright).
 */
const buildAssistantTextTurn = (
    msg: ContextMessage,
    inputs: TurnInputs,
    carriesAttachments: boolean
): BuiltTurn => {
    // Parse modelParts if available
    const modelParts = (() => {
        try {
            return msg.modelParts
                ? JSON.parse(JSON.stringify(msg.modelParts))
                : undefined;
        } catch {
            return undefined;
        }
    })();

    const contextNumber = inputs.index.numberOf.get(msg.messageId);
    const numberLabel = contextNumber === undefined ? '' : `[#${contextNumber}]\n`;
    // The file message itself, named (the bytes are not replayed)
    const fileNote = msg.mediaHint?.startsWith('a file: ') ? `[sent ${msg.mediaHint}]\n` : '';
    // A card's HTML is never replayed either. What the model reads back is the
    // rendered PNG (the row's file, replayed by the attachment turn), the
    // caption (stored as text), this fact line and, for A2UI mode, the source
    // surface it was built from.
    const widgetNote = msg.mediaHint?.startsWith('a widget') ? '[sent a widget]\n' : '';
    const surfaceNote = widgetNote
        ? renderA2uiSurfaceNote(inputs.widgetSurfaces.get(msg.messageId))
        : '';

    const parts: UnifiedContentPart[] = [];

    // An attachment-only reply still needs the label, so the model can refer to it
    const body =
        stripLeakedWireFormat(msg.text ?? '') ||
        (carriesAttachments || fileNote || widgetNote ? '' : missingAssistantText(msg, contextNumber));
    if (numberLabel || fileNote || widgetNote || body) {
        parts.push({ type: 'text', text: `${numberLabel}${fileNote}${widgetNote}${surfaceNote}${body}` });
    }

    return {
        message: {
            role: 'assistant',
            content: parts,
            modelParts: modelParts && Array.isArray(modelParts) ? modelParts : undefined,
        },
        images: [],
    };
};

/**
 * The reply's attachment bytes, replayed in their own **user-role** turn.
 *
 * Pictures must not ride an assistant turn: Gemini reads assistant inlineData as
 * images the model itself produced, and a model without an image-output channel
 * answers such a context by continuing that format — on 2026-11-11
 * gemini-4-carbon turned eleven replies into nothing but `<end_of_image>`
 * control tokens because the reply it was following had a sticker replayed on
 * the assistant side. The bytes are the same either way; only the role changes,
 * and a user turn is where Gemini accepts input media.
 */
const buildAssistantAttachmentTurn = (
    msg: ContextMessage,
    fileContents: UnifiedContentPart[],
    inputs: TurnInputs
): BuiltTurn => {
    const contextNumber = inputs.index.numberOf.get(msg.messageId);
    const note =
        contextNumber === undefined
            ? '[system] 以下是你在对话中发出的附件。'
            : `[system] 以下是你在 #${contextNumber} 那条回复里发出的附件。`;
    return {
        message: {
            role: 'user',
            content: [{ type: 'text', text: note }, ...fileContents],
        },
        // The attachment pictures stay this message's for tools (#N 的第 k 张图)
        images: contextImagesOf(fileContents, 'attachment'),
    };
};

/** What one turn is built from besides the message and its files */
interface TurnInputs {
    capabilities: ModelCapabilities;
    index: ContextNumbering;
    /** The chat's excluded messages: never quoted as reply targets */
    exclusions: ReadonlySet<number>;
    customEmojiAnnotation?: string;
    customEmojiAtlasParts: UnifiedContentPart[];
    answeredElsewhereNumber?: number;
    messageLinkPlan?: TgMessageLinkPlan;
    /** The widget each bot message of the context carried, by message id */
    widgetSurfaces: ReadonlyMap<number, WidgetSurfaceInfo>;
    chatTitle: string | null;
    /** Panel model view: previews come from caches only, never the network */
    dryRun: boolean;
}

/**
 * Build the user turn: media parts + rendered header/text + link preview +
 * capability-aware media nudges.
 */
const buildUserMessage = async (
    msg: ContextMessage,
    fileContents: UnifiedContentPart[],
    inputs: TurnInputs
): Promise<BuiltTurn> => {
    const {
        capabilities,
        index,
        customEmojiAnnotation,
        customEmojiAtlasParts,
        answeredElsewhereNumber,
        messageLinkPlan,
        chatTitle,
    } = inputs;
    const replyAnnotations = await buildReplyAnnotations(msg, index, inputs.exclusions);
    const mediaVisible = mediaVisibleToModel(fileContents, capabilities);

    const header = renderMessageHeader(
        msg,
        index.numberOf.get(msg.messageId),
        replyAnnotations,
        mediaVisible
    );

    const parts: UnifiedContentPart[] = [
        ...fileContents,
        ...customEmojiAtlasParts,
        { type: 'text', text: renderUserText(header, msg.text) },
    ];
    if (customEmojiAnnotation) {
        parts.push({ type: 'text', text: customEmojiAnnotation });
    }

    // Images the model can't see are dropped downstream, so their recognized
    // text is all it will ever get about them.
    if (msg.ocrText && !mediaVisible) {
        parts.push({ type: 'text', text: buildOcrFallbackPart(msg.ocrText) });
    }

    // Link preview (text + media) for the first URL, served from the
    // URL-addressed cache filled by autoSave via luoxu.
    const previewParts = await getLinkPreviewParts(msg.text, {
        includeOcrFallback: !capabilities.supportsImageInput,
    });
    parts.push(...previewParts);

    // t.me message links: the linked message (+ the one it replies to) and its
    // media, read from the snapshot cache or our own database.
    const messageLinkParts = await getTgMessageLinkPreviewParts(
        msg.chatId,
        messageLinkPlan,
        index.numberOf,
        { chatTitle }
    );
    parts.push(...messageLinkParts);

    // Viewer danmaku for a bilibili video shared through @bilifeedbot.
    const danmakuPart = await getBilibiliDanmakuPart(msg, { offline: inputs.dryRun });
    if (danmakuPart) {
        parts.push(danmakuPart);
    }

    // Nudges about the attachments the model can really see (watch/listen,
    // sticker emoji, sticker clips).
    const visibleParts = [...fileContents, ...previewParts, ...messageLinkParts].filter((part) =>
        partVisibleToModel(part, capabilities)
    );
    for (const nudge of buildMediaNudges(visibleParts)) {
        parts.push({ type: 'text', text: nudge });
    }

    // Another session is generating the reply this message asks for
    if (answeredElsewhereNumber !== undefined) {
        parts.push({ type: 'text', text: buildInFlightReplyNote(answeredElsewhereNumber) });
    }

    return {
        message: {
            role: 'user',
            content: parts,
        },
        // In the same order the parts appear: attachments, then the two preview kinds.
        // The custom emoji atlas stays out on purpose — it is a contact sheet of
        // emoji the system added, not a picture the conversation is about.
        images: [
            ...contextImagesOf(fileContents, 'attachment'),
            ...contextImagesOf(previewParts, 'linkPreview'),
            ...contextImagesOf(messageLinkParts, 'messageLink'),
        ],
    };
};

/**
 * Build context from a single message
 */
const buildMessageContent = async (
    msg: ContextMessage,
    fileContents: UnifiedContentPart[],
    inputs: TurnInputs
): Promise<BuiltTurn[]> => {
    if (!msg.fromBotSelf) return [await buildUserMessage(msg, fileContents, inputs)];
    const textTurn = buildAssistantTextTurn(msg, inputs, fileContents.length > 0);
    if (fileContents.length === 0) return [textTurn];
    const attachmentTurn = buildAssistantAttachmentTurn(msg, fileContents, inputs);
    // A reply that carried nothing but attachments has no text turn to keep
    return textTurn.message.content.length === 0 ? [attachmentTurn] : [textTurn, attachmentTurn];
};

/**
 * Options for building context
 */
export interface BuildContextOptions {
    /** Model capabilities for filtering */
    capabilities?: ModelCapabilities;
    /** Model id rendered into the runtime block (defaults to the global default model) */
    model?: string;
    /** Title of the chat this reply happens in (runtime block); null for private chats */
    chatTitle?: string | null;
    /**
     * The chat's prompt addendum, from the caller's settings snapshot (never
     * read here: the context may be built minutes after the reply started).
     * Closes the runtime block; left out for models whose chat system prompt
     * is replaced, where it would read as part of the image description.
     */
    chatAddendum?: string | null;
    /** Message IDs to exclude from context (e.g., current bot response when retrying) */
    excludeMessageIds?: number[];
    /**
     * The panel's model view: build exactly what a retry would send, without
     * any side effect. The tree is read without luoxu backfill, the `#N`
     * numbering is not published (it would overwrite a running reply's), and
     * previews come from caches and snapshots only — never the network.
     * Media are still read as usual (that renews their cache entries).
     */
    dryRun?: boolean;
}

/** Distinguish the options object from a bare ModelCapabilities argument. */
const isBuildContextOptions = (
    value: BuildContextOptions | ModelCapabilities | undefined
): value is BuildContextOptions =>
    typeof value === 'object' &&
    value !== null &&
    ('capabilities' in value ||
        'excludeMessageIds' in value ||
        'model' in value ||
        'chatTitle' in value ||
        'chatAddendum' in value ||
        'dryRun' in value);

/** Assembled context: the model-facing turns plus the user roster they involve */
export interface BuiltContext {
    messages: UnifiedMessage[];
    /** Authors and mentioned users, for the system prompt's roster section */
    contextUsers: ContextUser[];
    /** `#N` → message, for tools that take context numbers */
    contextIndex: ContextIndex;
    /**
     * Index of the trigger message in the final `messages` array. A volatile
     * block (the workspace manifest) is appended there after the tool snapshot
     * is known; the index is computed after capability merging, because
     * `requiresMessageMerge` platforms (deepseek-reasoner) shorten the array.
     */
    triggerTurnIndex: number;
    /**
     * Reply-tree roots represented in this context, the trigger's conversation
     * first: the workspace tools address one of these.
     */
    conversationRootIds: number[];
}

/** The numbering as tools see it: keyed by `#N`, with each message's pictures */
const buildToolContextIndex = (
    numbering: ContextNumbering,
    imagesByMessageId: ReadonlyMap<number, readonly ContextImage[]>
): ContextIndex => {
    const contextIndex = new Map<number, ContextIndexEntry>();
    for (const [messageId, number] of numbering.numberOf) {
        const images = imagesByMessageId.get(messageId) ?? [];
        const message = numbering.byId.get(messageId);
        contextIndex.set(number, {
            number,
            messageId,
            fromBot: message?.fromBotSelf ?? false,
            // The author is what `avatar='#N'` means
            authorUserId: message?.userId ?? null,
            ...(message === undefined ? {} : { authorName: message.userName }),
            images,
            imageCount: images.length,
        });
    }
    return contextIndex;
};

/**
 * Messages in this context whose reply is already being generated by another
 * session, mapped to the `#N` that context gave them. Only messages that really
 * are in the context qualify — a reply running somewhere else in the chat is
 * none of this reply's business. The current message is skipped: its own reply
 * is the one being built.
 */
const findRepliesInFlightElsewhere = (
    chatId: number,
    currentMessageId: number,
    index: ContextNumbering
): Map<number, number> => {
    const answeredElsewhere = new Map<number, number>();

    for (const messageId of getRepliesInFlight(chatId)) {
        if (messageId === currentMessageId) continue;
        const contextNumber = index.numberOf.get(messageId);
        if (contextNumber !== undefined) {
            answeredElsewhere.set(messageId, contextNumber);
        }
    }

    return answeredElsewhere;
};

/**
 * Index of the message carrying the runtime block, on the final (capability-
 * filtered, possibly merged) message array. The block is a text part with an
 * exact, unique string, so locating it is cheaper and safer than tracking the
 * pre-merge index. Falls back to the last message.
 */
const findTriggerTurnIndex = (messages: readonly UnifiedMessage[], runtimeText: string): number => {
    if (messages.length === 0) return 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const content = messages[index]?.content ?? [];
        if (content.some((part) => part.type === 'text' && part.text === runtimeText)) return index;
    }
    return messages.length - 1;
};

/**
 * Build complete chat context from a message
 * This is the main entry point for building AI request context
 */
export const buildContext = async (
    msg: Message,
    options?: BuildContextOptions | ModelCapabilities
): Promise<BuiltContext> => {
    const { chatId, messageId } = msg;

    // Handle both old signature (capabilities) and new signature (options)
    const opts: BuildContextOptions = isBuildContextOptions(options)
        ? options
        : { capabilities: options };

    // Get capabilities for current model if not provided
    const model = opts.model ?? getGlobalDefaultModel();
    const modelCapabilities = opts.capabilities ?? getModelCapabilities(model);
    const dryRun = opts.dryRun === true;

    // The reply tree, the current message closing it, and the replied-to
    // messages the tree misses. Resolved fresh here (not reused from a caller
    // snapshot) so any media that finished downloading during an upstream wait
    // is reflected — fileUniqueId is read up to date.
    const assembled = await assembleContextMessages(chatId, messageId, {
        trigger: toContextMessage(msg),
        excludeMessageIds: opts.excludeMessageIds ?? [],
        recover: !dryRun,
    });
    const contextMessages = assembled.messages;
    const index = assembled.numbering;
    // Newest-first budget: keeps the current exchange covered when a long
    // history carries many pasted links.
    const messageLinkPlan = planTgMessageLinkPreviews(
        chatId,
        contextMessages
            .filter((contextMessage) => !contextMessage.fromBotSelf)
            .map((contextMessage) => ({
                messageId: contextMessage.messageId,
                text: contextMessage.text,
            }))
    );
    if (!dryRun) publishContextNumbering(chatId, messageId, index);
    const repliesInFlightElsewhere = findRepliesInFlightElsewhere(chatId, messageId, index);

    const [contextUsers, customEmojiPlan, widgetSurfaces] = await Promise.all([
        collectContextUsers(contextMessages),
        buildCustomEmojiContextPlan(
            chatId,
            contextMessages.map((contextMessage) => contextMessage.messageId),
            modelCapabilities.supportsImageInput
        ),
        // Only the cards in this context are read; their rendered PNG needs no
        // query (it is the bot row's file), the A2UI source does
        loadWidgetSurfaces(
            chatId,
            contextMessages
                .filter(
                    (contextMessage) =>
                        contextMessage.fromBotSelf && contextMessage.mediaHint?.startsWith('a widget')
                )
                .map((contextMessage) => contextMessage.messageId)
        ),
    ]);

    const turns: MediaDedupeInput[] = [];
    for (const contextMsg of contextMessages) {
        // Loaded once: the turn is built from these parts, and the tool index
        // keeps the pictures among them before any capability filtering
        const fileContents = await loadMessageFiles(contextMsg);
        const builtTurns = await buildMessageContent(contextMsg, fileContents, {
            capabilities: modelCapabilities,
            index,
            exclusions: assembled.exclusions,
            customEmojiAnnotation: customEmojiPlan.annotations.get(contextMsg.messageId),
            customEmojiAtlasParts: contextMsg.messageId === messageId ? customEmojiPlan.atlasParts : [],
            answeredElsewhereNumber: repliesInFlightElsewhere.get(contextMsg.messageId),
            messageLinkPlan: messageLinkPlan.get(contextMsg.messageId),
            widgetSurfaces,
            chatTitle: opts.chatTitle ?? null,
            dryRun,
        });
        // One message can build two turns (a bot reply's text, then its
        // attachments in a user-role carrier); both belong to the same message
        for (const built of builtTurns) {
            turns.push({ messageId: contextMsg.messageId, message: built.message, images: built.images });
        }
    }

    // The same file can arrive twice (a repost, a forward, a linked message):
    // keep the first copy and say where it is instead of paying for it twice
    const deduped = dedupeContextMedia(turns, {
        supportsImageInput: modelCapabilities.supportsImageInput === true,
        supportsMediaInput: modelCapabilities.supportsMediaInput === true,
        contextNumbers: index.numberOf,
    });
    if (deduped.removed > 0) {
        console.log(`[context-builder] ${deduped.removed} duplicate media part(s) replaced by a note`);
    }

    const chatContents: UnifiedMessage[] = [];
    // The message each turn came from: a message can own two turns, and the
    // runtime block below must still find the trigger by id, not by position
    const turnMessageIds: number[] = [];
    const imagesByMessageId = new Map<number, readonly ContextImage[]>();
    for (const turn of deduped.turns) {
        chatContents.push(turn.message);
        turnMessageIds.push(turn.messageId);
        const previous = imagesByMessageId.get(turn.messageId);
        imagesByMessageId.set(
            turn.messageId,
            previous === undefined ? turn.images : [...previous, ...turn.images]
        );
    }

    // Runtime info (time, model, roster) rides the newest message instead of
    // heading the prompt: it is the only part that changes between requests, so
    // keeping it last leaves the cacheable prefix byte-identical. The next
    // request in this tree diverges at this very message and no earlier.
    const chatAddendum = replacesChatSystemPrompt(model) ? null : opts.chatAddendum ?? null;
    const runtimeBlock: UnifiedContentPart = {
        type: 'text',
        text: buildRuntimeContext(model, contextUsers, opts.chatTitle ?? null, chatAddendum),
    };
    const newestIndex = Math.max(0, turnMessageIds.indexOf(messageId));
    const withRuntime = chatContents.map((content, contentIndex) =>
        contentIndex === newestIndex
            ? { ...content, content: [...content.content, runtimeBlock] }
            : content
    );

    // Apply model capabilities (filter images, merge messages if needed). The
    // trigger index is located on the FINAL array: a merging platform may have
    // concatenated adjacent user turns, and the runtime block part survives
    // that concatenation unchanged.
    const finalMessages = applyModelCapabilities(withRuntime, modelCapabilities);
    return {
        messages: finalMessages,
        contextUsers,
        contextIndex: buildToolContextIndex(index, imagesByMessageId),
        triggerTurnIndex: findTriggerTurnIndex(finalMessages, runtimeBlock.text ?? ''),
        conversationRootIds: assembled.conversationRootIds,
    };
};

/**
 * Build context for a simple prompt without history
 */
export const buildSimpleContext = (
    prompt: string,
    images?: string[]
): UnifiedMessage[] => {
    const parts: UnifiedContentPart[] = [{ type: 'text', text: prompt }];

    if (images) {
        images.forEach((imageData) => {
            parts.push({ type: 'image', imageData });
        });
    }

    return [{ role: 'user', content: parts }];
};

/**
 * Build context from content parts (for picbanana etc.)
 */
export const buildContextFromParts = (
    parts: UnifiedContentPart[]
): UnifiedMessage[] => {
    return [{ role: 'user', content: parts }];
};
