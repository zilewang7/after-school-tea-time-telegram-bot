/**
 * Context builder for AI chat
 * Builds unified message context from database messages
 */
import { getMessage } from '../db/index.js';
import { Message } from '../db/messageDTO.js';
import { getRepliesHistory, getFileContentsOfMessage, type ContextMessage } from '../db/queries/context-queries.js';
import { getLinkPreviewParts } from '../services/luoxu-preview-service.js';
import { applyModelCapabilities } from '../ai/message-transformer.js';
import { getCurrentModel } from '../state.js';
import { getModelCapabilities } from '../ai/platform-factory.js';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types.js';

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

// Models tend to reply from the surrounding text and skip attached video/audio.
// Only emitted when the model can actually ingest such media
// (supportsMediaInput), and named after what is really attached.
const buildMediaNudge = (kinds: Array<'video' | 'audio'>): string => {
    const noun = kinds.join(' and ');
    const verb = kinds.map((kind) => (kind === 'video' ? 'watch' : 'listen to')).join(' / ');
    return `[system] A ${noun} file is attached in this message. You can fully perceive it — actually ${verb} it and weave a concrete description of its real content into your reply; do not respond from the surrounding text alone.`;
};

/** Whether every attached media part survives the model's capability filter */
const mediaVisibleToModel = (
    mediaParts: UnifiedContentPart[],
    capabilities: ModelCapabilities
): boolean =>
    mediaParts.length > 0 &&
    mediaParts.every((part) =>
        part.type === 'image' ? capabilities.supportsImageInput : capabilities.supportsMediaInput
    );

/**
 * Render the model-facing header: `用户名 [annotation…]: `.
 * All metadata (forward origin, reply context, attached media) becomes
 * square-bracket annotations between the name and the colon.
 */
const renderMessageHeader = (
    msg: Pick<ContextMessage, 'userName' | 'forwardOrigin' | 'mediaHint'>,
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
    return `${msg.userName}${annotations.length ? ' ' + annotations.join(' ') : ''}: `;
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
 * Build context from a single message
 */
const buildMessageContent = async (
    msg: ContextMessage,
    capabilities: ModelCapabilities,
): Promise<UnifiedMessage> => {
    // Get file contents if message references a file (legacy BLOB or cached media)
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

    if (msg.fromBotSelf) {
        // Assistant message
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
    } else {
        // User message
        return buildUserMessage(msg, capabilities, []);
    }
};

/**
 * Build reply annotations for the current message,
 * e.g. `[replying to 某某: "开头摘要"]` and `[quote: "引文"]`.
 */
const buildReplyAnnotations = async (
    chatId: number,
    replyToId: number | null,
    quoteText: string | null
): Promise<string[]> => {
    const annotations: string[] = [];

    if (replyToId) {
        const replyMsg = await getMessage(chatId, replyToId);
        const replyText = replyMsg?.text?.replace(/<<EOF\s*$/, '').trim();
        if (replyMsg && replyText) {
            // Slice by unicode codepoints (avoid breaking emoji)
            const chars = Array.from(replyText);
            const excerpt = chars.length > 20 ? chars.slice(0, 20).join('') + '…' : replyText;
            annotations.push(`[replying to ${replyMsg.userName}: "${excerpt}"]`);
        } else {
            annotations.push('[replying to the last message]');
        }
    }

    if (quoteText) {
        annotations.push(`[quote: "${quoteText}"]`);
    }

    return annotations;
};

/**
 * Shared user-message assembly: media parts + rendered header/text + link
 * preview + capability-aware media nudge.
 */
const buildUserMessage = async (
    msg: Pick<ContextMessage, 'chatId' | 'messageId' | 'userName' | 'text' | 'file' | 'fileUniqueId' | 'mediaHint' | 'forwardOrigin'>,
    capabilities: ModelCapabilities,
    replyAnnotations: string[],
): Promise<UnifiedMessage> => {
    const fileContents = (msg.file || msg.fileUniqueId)
        ? await getFileContentsOfMessage(msg.chatId, msg.messageId)
        : [];

    const header = renderMessageHeader(
        msg,
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

    // Nudge the model to actually watch/listen to attached video/audio — only
    // when the model can ingest that media at all, named after what's attached.
    if (capabilities.supportsMediaInput) {
        const kinds = audioVisualKinds([...fileContents, ...previewParts]);
        if (kinds.length) {
            parts.push({ type: 'text', text: buildMediaNudge(kinds) });
        }
    }

    return {
        role: 'user',
        content: parts,
    };
};

/**
 * Build the current message content with reply context
 */
const buildCurrentMessageContent = async (
    msg: Message,
    capabilities: ModelCapabilities,
): Promise<UnifiedMessage> => {
    const replyAnnotations = await buildReplyAnnotations(msg.chatId, msg.replyToId, msg.quoteText);
    return buildUserMessage(msg, capabilities, replyAnnotations);
};

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

    // Build context array
    const chatContents: UnifiedMessage[] = [];

    // Get history messages (excluding current message). Resolved fresh here (not
    // reused from a caller snapshot) so any media that finished downloading
    // during an upstream wait is reflected — fileUniqueId is read up to date.
    const historyMessages = await getRepliesHistory(chatId, messageId, {
        excludeSelf: true,
    });

    // Add history messages (excluding specified IDs)
    for (const historyMsg of historyMessages) {
        if (opts.excludeMessageIds?.includes(historyMsg.messageId)) {
            continue;
        }
        const content = await buildMessageContent(historyMsg, modelCapabilities);
        chatContents.push(content);
    }

    // Add current message with reply context
    const currentContent = await buildCurrentMessageContent(msg, modelCapabilities);
    chatContents.push(currentContent);

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
