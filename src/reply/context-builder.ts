/**
 * Context builder for AI chat
 * Builds unified message context from database messages
 */
import { match } from 'ts-pattern';
import { Message } from '../db/messageDTO.js';
import {
    getRepliesHistory,
    getContextMessage,
    getFileContentsOfMessage,
    toContextMessage,
    type ContextMessage,
} from '../db/queries/context-queries.js';
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
import { getCurrentModel, getRepliesInFlight, isBotReplyInFlight, setContextNumbering } from '../state.js';
import { buildInFlightOwnReplyNote, buildInFlightReplyNote } from './inflight-reply-note.js';
import { collectContextUsers, type ContextUser } from './context-users.js';
import { getModelCapabilities } from '../ai/platform-factory.js';
import { buildCustomEmojiContextPlan } from '../services/custom-emoji-context-service.js';
import { contextImagesOf, type ContextImage } from './context-images.js';
import type { ContextIndex, ContextIndexEntry } from './context-index.js';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types.js';

/** Sticker kinds as recorded by autoSave when the media was captured */
const STICKER_KINDS = new Set(['sticker', 'video_sticker', 'animated_sticker', 'animated_sticker_still']);
/** Stickers that are short video clips rather than a single still frame */
const ANIMATED_STICKER_KINDS = new Set(['video_sticker', 'animated_sticker']);

/** One-line excerpt caps for the header annotations */
const REPLY_EXCERPT_CHARS = 40;
const QUOTE_EXCERPT_CHARS = 300;

/**
 * How many replied-to messages may be pulled into the context when they are not
 * part of the assembled tree. Bounded because each one drags its media along.
 */
const MAX_PULLED_REPLY_TARGETS = 8;

/**
 * Media-group members other than the first carry no content of their own — their
 * media is attached to the group's first message, which is the one in context.
 */
const SUB_IMAGE_PATTERN = /sub image of \[\w+\]/;
const isSubImage = (msg: ContextMessage): boolean =>
    Boolean(msg.text && SUB_IMAGE_PATTERN.test(msg.text));

const isSticker = (part: UnifiedContentPart): boolean =>
    Boolean(part.mediaKind && STICKER_KINDS.has(part.mediaKind));

const isAnimatedSticker = (part: UnifiedContentPart): boolean =>
    Boolean(part.mediaKind && ANIMATED_STICKER_KINDS.has(part.mediaKind));

/**
 * A sticker message row, from the hint autoSave stored for it. Bot rows carry
 * the short 'sticker'; user rows the longer media hints (and backfilled rows
 * the recovered-history wording).
 */
const isStickerMessage = (msg: ContextMessage): boolean =>
    msg.mediaHint === 'sticker' ||
    msg.mediaHint?.startsWith('a sticker') === true ||
    msg.mediaHint?.startsWith('an animated sticker') === true;

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
    const verb = kinds.map((kind) => (kind === 'video' ? 'watch' : 'listen to')).join(' / ');
    return `[system] A ${noun} file is attached in this message. You can fully perceive it — actually ${verb} it and weave a concrete description of its real content into your reply; do not respond from the surrounding text alone. If one of your earlier replies already described this same file, do not describe it again.`;
};

// Sticker clips are tone, not content: describing them is optional, and the
// description must not be repeated in every following reply.
const ANIMATED_STICKER_NUDGE =
    '[system] The attached sticker is a short video clip — play it through to know what it really shows. Being a sticker it mostly carries tone, so describe it only when the description adds something to your reply, skip it when it does not, and never repeat a description you already gave in an earlier reply.';

// The pack emoji rides along in the media hint but says little about the artwork.
const STICKER_EMOJI_NUDGE =
    "[system] A sticker's pack emoji is loose metadata that Telegram often assigns automatically, and it frequently has nothing to do with the artwork. Judge the sticker by the image/clip attached to you, never by that emoji.";

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
 * Numbering of one assembled context: a `#N` label for every message plus a
 * lookup of everything in the context, so a reply can point at a number instead
 * of a truncated excerpt.
 */
interface ContextNumbering {
    /** messageId → display number; every message in the context has one */
    numberOf: Map<number, number>;
    /** Every message in the assembled context, by message id */
    byId: Map<number, ContextMessage>;
}

/**
 * Number every message in context order, the bot's own replies included, so it
 * can point at what it said itself (`我在 #5 说过`) instead of describing it.
 */
const buildContextNumbering = (messages: ContextMessage[]): ContextNumbering => {
    const numberOf = new Map<number, number>();
    const byId = new Map<number, ContextMessage>();

    for (const message of messages) {
        byId.set(message.messageId, message);
        numberOf.set(message.messageId, numberOf.size + 1);
    }

    return { numberOf, byId };
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
 * Pull in messages that are replied to but missing from the assembled tree
 * (e.g. a /chat-added message answering something outside the reply chain), so
 * the reply can be referenced by number rather than by excerpt. One level only,
 * capped, chronological order preserved (message ids grow with time, so the
 * current message stays last).
 */
const withMissingReplyTargets = async (
    chatId: number,
    messages: ContextMessage[],
    excludeMessageIds: number[]
): Promise<ContextMessage[]> => {
    const present = new Set(messages.map((message) => message.messageId));
    const excluded = new Set(excludeMessageIds);

    const missingIds = [
        ...new Set(
            messages
                .map((message) => message.replyToId)
                .filter((id): id is number => id !== null && !present.has(id) && !excluded.has(id))
        ),
    ];
    if (!missingIds.length) return messages;

    if (missingIds.length > MAX_PULLED_REPLY_TARGETS) {
        console.log(
            `[context-builder] ${missingIds.length - MAX_PULLED_REPLY_TARGETS} replied-to message(s) left out of context (cap ${MAX_PULLED_REPLY_TARGETS})`
        );
    }

    const pulled: ContextMessage[] = [];
    for (const messageId of missingIds.slice(0, MAX_PULLED_REPLY_TARGETS)) {
        const target = await getContextMessage(chatId, messageId);
        // Sub-images stay out: their media already rides on the group's first message
        if (target && !isSubImage(target)) pulled.push(target);
    }
    if (!pulled.length) return messages;

    return [...messages, ...pulled].sort((a, b) => a.messageId - b.messageId);
};

/**
 * Render `[replying to …]` for one reply target: by context number when the
 * target is in the context, otherwise by a short excerpt of it.
 */
const renderReplyTarget = async (
    chatId: number,
    replyToId: number,
    index: ContextNumbering
): Promise<string> => {
    const target = index.byId.get(replyToId);

    if (target) {
        const targetNumber = index.numberOf.get(replyToId);
        // Telegram lets a user swipe-reply to any message, including a sticker
        // it merely scrolled past: state the medium, infer nothing from it.
        const medium = isStickerMessage(target) ? ' (a sticker)' : '';
        return target.fromBotSelf
            ? `[replying to your reply #${targetNumber}${medium}]`
            : `[replying to #${targetNumber} ${target.userName}${medium}]`;
    }

    const replyMsg = await getContextMessage(chatId, replyToId);
    if (replyMsg && isSubImage(replyMsg)) {
        return `[replying to one of ${replyMsg.userName}'s attached media]`;
    }
    if (replyMsg && isStickerMessage(replyMsg)) {
        return `[replying to ${replyMsg.userName}: a sticker]`;
    }
    const replyText = replyMsg?.text?.replace(/<<EOF\s*$/, '').trim();
    if (replyMsg && replyText) {
        return `[replying to ${replyMsg.userName}: "${oneLineExcerpt(replyText, REPLY_EXCERPT_CHARS)}"]`;
    }
    return '[replying to a message you cannot see]';
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
    index: ContextNumbering
): Promise<string[]> => {
    const annotations: string[] = [];

    if (msg.chatCommand) {
        // A /chat summon describes itself; it is never "replying to" its target
        const annotation = renderChatCommandAnnotation(msg, index);
        if (annotation) annotations.push(annotation);
    } else if (msg.replyToId) {
        annotations.push(await renderReplyTarget(msg.chatId, msg.replyToId, index));
    }

    if (msg.quoteText) {
        annotations.push(`[quote: "${oneLineExcerpt(msg.quoteText, QUOTE_EXCERPT_CHARS)}"]`);
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
    const annotations: string[] = [];
    if (msg.forwardOrigin) {
        annotations.push(`[forwarded from ${msg.forwardOrigin}]`);
    }
    if (msg.viaBot) {
        annotations.push(`[via inline bot ${msg.viaBot}]`);
    }
    annotations.push(...replyAnnotations);
    if (msg.mediaHint) {
        // failure hints already end with "you cannot see it" — don't double up
        const invisible = !mediaVisible && !msg.mediaHint.includes('you cannot see it');
        annotations.push(`[sent ${msg.mediaHint}${invisible ? ' — not visible to you' : ''}]`);
    }
    const numberPrefix = contextNumber === undefined ? '' : `#${contextNumber} `;
    return `${numberPrefix}${msg.userName}${annotations.length ? ' ' + annotations.join(' ') : ''}`;
};

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
 * parts, unfiltered by model capabilities.
 */
const loadMessageFiles = async (msg: ContextMessage): Promise<UnifiedContentPart[]> =>
    msg.file || msg.fileUniqueId ? getFileContentsOfMessage(msg.chatId, msg.messageId) : [];

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
 * What an assistant turn with no text says. A reply that is still streaming has
 * a stored row but no content yet — report that, instead of calling it lost.
 */
const missingAssistantText = (
    msg: ContextMessage,
    contextNumber: number | undefined
): string =>
    contextNumber !== undefined && isBotReplyInFlight(msg.chatId, msg.messageId)
        ? buildInFlightOwnReplyNote(contextNumber)
        : '[system] message lost';

/**
 * Build the assistant turn for one of the bot's own messages.
 *
 * The context number is prefixed as `[#5]` on its own line — deliberately a
 * different shape from the `#5 用户名:` header of user messages, so the model is
 * less tempted to imitate it (the system prompt also forbids it outright).
 */
const buildAssistantMessage = (
    msg: ContextMessage,
    fileContents: UnifiedContentPart[],
    index: ContextNumbering
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

    const contextNumber = index.numberOf.get(msg.messageId);
    const numberLabel = contextNumber === undefined ? '' : `[#${contextNumber}]\n`;

    const parts: UnifiedContentPart[] = [...fileContents];

    // An image-only reply still needs the label, so the model can refer to it
    const body =
        stripLeakedWireFormat(msg.text ?? '') ||
        (fileContents.length ? '' : missingAssistantText(msg, contextNumber));
    if (numberLabel || body) {
        parts.push({ type: 'text', text: `${numberLabel}${body}` });
    }

    return {
        message: {
            role: 'assistant',
            content: parts,
            modelParts: modelParts && Array.isArray(modelParts) ? modelParts : undefined,
        },
        // Our own turns carry their attachments only; link previews are built for user turns
        images: contextImagesOf(fileContents, 'attachment'),
    };
};

/**
 * Build the user turn: media parts + rendered header/text + link preview +
 * capability-aware media nudges.
 */
const buildUserMessage = async (
    msg: ContextMessage,
    fileContents: UnifiedContentPart[],
    capabilities: ModelCapabilities,
    index: ContextNumbering,
    customEmojiAnnotation?: string,
    customEmojiAtlasParts: UnifiedContentPart[] = [],
    answeredElsewhereNumber?: number,
    messageLinkPlan?: TgMessageLinkPlan,
    chatTitle?: string | null
): Promise<BuiltTurn> => {
    const replyAnnotations = await buildReplyAnnotations(msg, index);
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
    const danmakuPart = await getBilibiliDanmakuPart(msg);
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
    capabilities: ModelCapabilities,
    index: ContextNumbering,
    customEmojiAnnotation?: string,
    customEmojiAtlasParts: UnifiedContentPart[] = [],
    answeredElsewhereNumber?: number,
    messageLinkPlan?: TgMessageLinkPlan,
    chatTitle?: string | null
): Promise<BuiltTurn> =>
    msg.fromBotSelf
        ? buildAssistantMessage(msg, fileContents, index)
        : buildUserMessage(
            msg,
            fileContents,
            capabilities,
            index,
            customEmojiAnnotation,
            customEmojiAtlasParts,
            answeredElsewhereNumber,
            messageLinkPlan,
            chatTitle
        );

/**
 * Options for building context
 */
export interface BuildContextOptions {
    /** Model capabilities for filtering */
    capabilities?: ModelCapabilities;
    /** Model id rendered into the runtime block (defaults to the chat's model) */
    model?: string;
    /** Title of the chat this reply happens in (runtime block); null for private chats */
    chatTitle?: string | null;
    /** Message IDs to exclude from context (e.g., current bot response when retrying) */
    excludeMessageIds?: number[];
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
        'chatTitle' in value);

/** Assembled context: the model-facing turns plus the user roster they involve */
export interface BuiltContext {
    messages: UnifiedMessage[];
    /** Authors and mentioned users, for the system prompt's roster section */
    contextUsers: ContextUser[];
    /** `#N` → message, for tools that take context numbers */
    contextIndex: ContextIndex;
}

/** The numbering as tools see it: keyed by `#N`, with each message's pictures */
const buildToolContextIndex = (
    numbering: ContextNumbering,
    imagesByMessageId: ReadonlyMap<number, readonly ContextImage[]>
): ContextIndex => {
    const contextIndex = new Map<number, ContextIndexEntry>();
    for (const [messageId, number] of numbering.numberOf) {
        const images = imagesByMessageId.get(messageId) ?? [];
        contextIndex.set(number, {
            number,
            messageId,
            fromBot: numbering.byId.get(messageId)?.fromBotSelf ?? false,
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
    const model = opts.model ?? getCurrentModel();
    const modelCapabilities = opts.capabilities ?? getModelCapabilities(model);
    const excludeMessageIds = opts.excludeMessageIds ?? [];

    // Get history messages (excluding current message). Resolved fresh here (not
    // reused from a caller snapshot) so any media that finished downloading
    // during an upstream wait is reflected — fileUniqueId is read up to date.
    const historyMessages = await getRepliesHistory(chatId, messageId, {
        excludeSelf: true,
    });

    // The current message closes the context (its id is the newest, so it stays
    // last through the chronological sort below).
    const assembled = [
        ...historyMessages.filter((historyMsg) => !excludeMessageIds.includes(historyMsg.messageId)),
        toContextMessage(msg),
    ];

    const contextMessages = await withMissingReplyTargets(chatId, assembled, excludeMessageIds);
    const index = buildContextNumbering(contextMessages);
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
    publishContextNumbering(chatId, messageId, index);
    const repliesInFlightElsewhere = findRepliesInFlightElsewhere(chatId, messageId, index);

    const [contextUsers, customEmojiPlan] = await Promise.all([
        collectContextUsers(contextMessages),
        buildCustomEmojiContextPlan(
            chatId,
            contextMessages.map((contextMessage) => contextMessage.messageId),
            modelCapabilities.supportsImageInput
        ),
    ]);

    const chatContents: UnifiedMessage[] = [];
    const imagesByMessageId = new Map<number, readonly ContextImage[]>();
    for (const contextMsg of contextMessages) {
        // Loaded once: the turn is built from these parts, and the tool index
        // keeps the pictures among them before any capability filtering
        const fileContents = await loadMessageFiles(contextMsg);
        const turn = await buildMessageContent(
            contextMsg,
            fileContents,
            modelCapabilities,
            index,
            customEmojiPlan.annotations.get(contextMsg.messageId),
            contextMsg.messageId === messageId ? customEmojiPlan.atlasParts : [],
            repliesInFlightElsewhere.get(contextMsg.messageId),
            messageLinkPlan.get(contextMsg.messageId),
            opts.chatTitle ?? null
        );
        imagesByMessageId.set(contextMsg.messageId, turn.images);
        chatContents.push(turn.message);
    }

    // Runtime info (time, model, roster) rides the newest message instead of
    // heading the prompt: it is the only part that changes between requests, so
    // keeping it last leaves the cacheable prefix byte-identical. The next
    // request in this tree diverges at this very message and no earlier.
    const runtimeBlock: UnifiedContentPart = {
        type: 'text',
        text: buildRuntimeContext(model, contextUsers, opts.chatTitle ?? null),
    };
    const newestIndex = Math.max(
        0,
        contextMessages.findIndex((contextMsg) => contextMsg.messageId === messageId)
    );
    const withRuntime = chatContents.map((content, contentIndex) =>
        contentIndex === newestIndex
            ? { ...content, content: [...content.content, runtimeBlock] }
            : content
    );

    // Apply model capabilities (filter images, merge messages if needed)
    return {
        messages: applyModelCapabilities(withRuntime, modelCapabilities),
        contextUsers,
        contextIndex: buildToolContextIndex(index, imagesByMessageId),
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
