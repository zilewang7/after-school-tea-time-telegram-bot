/**
 * Context builder for AI chat
 * Builds unified message context from database messages
 */
import { getMessage } from '../db/index.js';
import { Message } from '../db/messageDTO.js';
import { getRepliesHistory, getFileContentsOfMessage, type ContextMessage } from '../db/queries/context-queries.js';
import { applyModelCapabilities } from '../ai/message-transformer.js';
import { getCurrentModel } from '../state.js';
import { getModelCapabilities } from '../ai/platform-factory.js';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types.js';

// Models tend to reply from the surrounding text and skip attached video/audio.
// This nudge (appended to messages that carry such media) tells them to actually
// perceive it and describe its real content.
const AUDIO_VISUAL_NUDGE =
    '[system] An audio/visual file is attached in this message. You can fully perceive it — actually watch/listen to it and weave a concrete description of its real content into your reply; do not respond from the surrounding text alone.';

const hasAudioVisualMedia = (parts: UnifiedContentPart[]): boolean =>
    parts.some(
        (part) =>
            part.type === 'media' &&
            (Boolean(part.mimeType?.startsWith('video/')) || Boolean(part.mimeType?.startsWith('audio/')))
    );

/**
 * Build context from a single message
 */
const buildMessageContent = async (
    msg: ContextMessage,
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
        const parts: UnifiedContentPart[] = [...fileContents];

        const textContent = `${msg.userName}: ${msg.text || ''}`;
        parts.push({ type: 'text', text: textContent });

        // Nudge the model to actually watch/listen to attached video/audio.
        if (hasAudioVisualMedia(fileContents)) {
            parts.push({ type: 'text', text: AUDIO_VISUAL_NUDGE });
        }

        return {
            role: 'user',
            content: parts,
        };
    }
};

/**
 * Build reply context text (e.g., "[replying to ...]")
 */
const buildReplyContext = async (
    chatId: number,
    replyToId: number | null,
    quoteText: string | null
): Promise<string> => {
    if (!replyToId) return ': ';

    let text = '([system]replying to ';
    const replyMsg = await getMessage(chatId, replyToId);

    if (replyMsg?.text) {
        text += `[${replyMsg.userName}:`;
        // Use Array.from to slice by unicode codepoints (avoid breaking emoji)
        const msgChars = Array.from(replyMsg.text);
        text += `${msgChars.length > 20 ? msgChars.slice(0, 20).join('') + '...' : msgChars.join('')}]`;
    } else {
        text += '[last message]';
    }

    if (quoteText) {
        text += `[quote: ${quoteText}]`;
    }

    text += '): ';
    return text;
};

/**
 * Build the current message content with reply context
 */
const buildCurrentMessageContent = async (msg: Message): Promise<UnifiedMessage> => {
    const fileContents = (msg.file || msg.fileUniqueId)
        ? await getFileContentsOfMessage(msg.chatId, msg.messageId)
        : [];

    const replyContext = await buildReplyContext(msg.chatId, msg.replyToId, msg.quoteText);

    const parts: UnifiedContentPart[] = [
        ...fileContents,
        {
            type: 'text',
            text: msg.userName + replyContext + (msg.text || ''),
        },
    ];

    // Nudge the model to actually watch/listen to attached video/audio.
    if (hasAudioVisualMedia(fileContents)) {
        parts.push({ type: 'text', text: AUDIO_VISUAL_NUDGE });
    }

    return {
        role: 'user',
        content: parts,
    };
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
        const content = await buildMessageContent(historyMsg);
        chatContents.push(content);
    }

    // Add current message with reply context
    const currentContent = await buildCurrentMessageContent(msg);
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
