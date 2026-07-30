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
import { applyModelCapabilities } from '../ai/message-transformer.js';
import { getCurrentModel, setContextNumbering } from '../state.js';
import { getModelCapabilities } from '../ai/platform-factory.js';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types.js';

/** Sticker kinds as recorded by autoSave when the media was captured */
const STICKER_KINDS = new Set(['sticker', 'video_sticker', 'animated_sticker']);
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
 * Numbering of one assembled context: `#N` labels for user messages plus a
 * lookup of everything in the context, so a reply can point at a number instead
 * of a truncated excerpt.
 */
interface ContextIndex {
    /** messageId → display number; bot replies are not numbered */
    numberOf: Map<number, number>;
    /** Every message in the assembled context, by message id */
    byId: Map<number, ContextMessage>;
}

/**
 * Number the user messages in context order. Bot replies stay unnumbered: their
 * text is replayed verbatim as the assistant turn (Gemini even replays raw
 * modelParts), so there is nowhere to render a label.
 */
const buildContextIndex = (messages: ContextMessage[]): ContextIndex => {
    const numberOf = new Map<number, number>();
    const byId = new Map<number, ContextMessage>();

    for (const message of messages) {
        byId.set(message.messageId, message);
        if (!message.fromBotSelf) {
            numberOf.set(message.messageId, numberOf.size + 1);
        }
    }

    return { numberOf, byId };
};

/**
 * Publish `#N → messageId` for the display layer, which turns the `#N` the
 * model writes back into clickable message links. Display-only: the reply that
 * gets persisted keeps the plain numbers.
 */
const publishContextNumbering = (
    chatId: number,
    userMessageId: number,
    index: ContextIndex
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
    index: ContextIndex
): Promise<string> => {
    const target = index.byId.get(replyToId);

    if (target && !target.fromBotSelf) {
        return `[replying to #${index.numberOf.get(replyToId)} ${target.userName}]`;
    }

    if (target) {
        // Bot replies carry no number — point at the user message they answered
        const answeredNumber = target.replyToId === null
            ? undefined
            : index.numberOf.get(target.replyToId);
        return answeredNumber
            ? `[replying to your reply to #${answeredNumber}]`
            : '[replying to your earlier reply]';
    }

    const replyMsg = await getContextMessage(chatId, replyToId);
    if (replyMsg && isSubImage(replyMsg)) {
        return `[replying to one of ${replyMsg.userName}'s attached media]`;
    }
    const replyText = replyMsg?.text?.replace(/<<EOF\s*$/, '').trim();
    if (replyMsg && replyText) {
        return `[replying to ${replyMsg.userName}: "${oneLineExcerpt(replyText, REPLY_EXCERPT_CHARS)}"]`;
    }
    return '[replying to a message you cannot see]';
};

/**
 * Build reply annotations for one message,
 * e.g. `[replying to #2 某某]` and `[quote: "引文"]`.
 */
const buildReplyAnnotations = async (
    msg: ContextMessage,
    index: ContextIndex
): Promise<string[]> => {
    const annotations: string[] = [];

    if (msg.replyToId) {
        annotations.push(await renderReplyTarget(msg.chatId, msg.replyToId, index));
    }

    if (msg.quoteText) {
        annotations.push(`[quote: "${oneLineExcerpt(msg.quoteText, QUOTE_EXCERPT_CHARS)}"]`);
    }

    return annotations;
};

/**
 * Render the model-facing header: `#N 用户名 [annotation…]: `.
 * All metadata (context number, forward origin, reply context, attached media)
 * becomes a prefix / square-bracket annotations between the name and the colon.
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
    annotations.push(...replyAnnotations);
    if (msg.mediaHint) {
        // failure hints already end with "you cannot see it" — don't double up
        const invisible = !mediaVisible && !msg.mediaHint.includes('you cannot see it');
        annotations.push(`[sent ${msg.mediaHint}${invisible ? ' — not visible to you' : ''}]`);
    }
    const numberPrefix = contextNumber === undefined ? '' : `#${contextNumber} `;
    return `${numberPrefix}${msg.userName}${annotations.length ? ' ' + annotations.join(' ') : ''}: `;
};

/**
 * Assemble the text part of a user message: header + content + EOF marker.
 * Legacy rows (<= 7 days old) already carry `<<EOF` inside the stored text;
 * those pass through unchanged.
 */
const renderUserText = (header: string, text: string | null): string => {
    const content = text || '';
    return content.includes('<<EOF') ? header + content : `${header}${content}\n<<EOF\n`;
};

/**
 * Build the assistant turn for one of the bot's own messages
 */
const buildAssistantMessage = async (msg: ContextMessage): Promise<UnifiedMessage> => {
    const fileContents = (msg.file || msg.fileUniqueId)
        ? await getFileContentsOfMessage(msg.chatId, msg.messageId)
        : [];

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

    const parts: UnifiedContentPart[] = [];

    if (fileContents.length) {
        parts.push(...fileContents);
    }

    if (msg.text) {
        parts.push({ type: 'text', text: msg.text });
    }

    return {
        role: 'assistant',
        content: parts.length ? parts : [{ type: 'text', text: msg.text || '[system] message lost' }],
        modelParts: modelParts && Array.isArray(modelParts) ? modelParts : undefined,
    };
};

/**
 * Build the user turn: media parts + rendered header/text + link preview +
 * capability-aware media nudges.
 */
const buildUserMessage = async (
    msg: ContextMessage,
    capabilities: ModelCapabilities,
    index: ContextIndex
): Promise<UnifiedMessage> => {
    const fileContents = (msg.file || msg.fileUniqueId)
        ? await getFileContentsOfMessage(msg.chatId, msg.messageId)
        : [];

    const replyAnnotations = await buildReplyAnnotations(msg, index);

    const header = renderMessageHeader(
        msg,
        index.numberOf.get(msg.messageId),
        replyAnnotations,
        mediaVisibleToModel(fileContents, capabilities)
    );

    const parts: UnifiedContentPart[] = [
        ...fileContents,
        { type: 'text', text: renderUserText(header, msg.text) },
    ];

    // Link preview (text + media) for the first URL, served from the
    // URL-addressed cache filled by autoSave via luoxu.
    const previewParts = await getLinkPreviewParts(msg.text);
    parts.push(...previewParts);

    // Nudges about the attachments the model can really see (watch/listen,
    // sticker emoji, sticker clips).
    const visibleParts = [...fileContents, ...previewParts].filter((part) =>
        partVisibleToModel(part, capabilities)
    );
    for (const nudge of buildMediaNudges(visibleParts)) {
        parts.push({ type: 'text', text: nudge });
    }

    return {
        role: 'user',
        content: parts,
    };
};

/**
 * Build context from a single message
 */
const buildMessageContent = async (
    msg: ContextMessage,
    capabilities: ModelCapabilities,
    index: ContextIndex
): Promise<UnifiedMessage> =>
    msg.fromBotSelf
        ? buildAssistantMessage(msg)
        : buildUserMessage(msg, capabilities, index);

/**
 * Options for building context
 */
export interface BuildContextOptions {
    /** Model capabilities for filtering */
    capabilities?: ModelCapabilities;
    /** Message IDs to exclude from context (e.g., current bot response when retrying) */
    excludeMessageIds?: number[];
}

/** Distinguish the options object from a bare ModelCapabilities argument. */
const isBuildContextOptions = (
    value: BuildContextOptions | ModelCapabilities | undefined
): value is BuildContextOptions =>
    typeof value === 'object' &&
    value !== null &&
    ('capabilities' in value || 'excludeMessageIds' in value);

/**
 * Build complete chat context from a message
 * This is the main entry point for building AI request context
 */
export const buildContext = async (
    msg: Message,
    options?: BuildContextOptions | ModelCapabilities
): Promise<UnifiedMessage[]> => {
    const { chatId, messageId } = msg;

    // Handle both old signature (capabilities) and new signature (options)
    const opts: BuildContextOptions = isBuildContextOptions(options)
        ? options
        : { capabilities: options };

    // Get capabilities for current model if not provided
    const modelCapabilities = opts.capabilities ?? getModelCapabilities(getCurrentModel());
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
    const index = buildContextIndex(contextMessages);
    publishContextNumbering(chatId, messageId, index);

    const chatContents: UnifiedMessage[] = [];
    for (const contextMsg of contextMessages) {
        chatContents.push(await buildMessageContent(contextMsg, modelCapabilities, index));
    }

    // Apply model capabilities (filter images, merge messages if needed)
    return applyModelCapabilities(chatContents, modelCapabilities);
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
