/**
 * Context builder for AI chat
 * Builds unified message context from database messages
 */
import { getMessage } from '../db';
import { Message } from '../db/messageDTO';
import { getRepliesHistory, getFileContentsOfMessage, type ContextMessage } from '../db/queries/context-queries';
import { applyModelCapabilities } from '../ai/message-transformer';
import { getCurrentModel } from '../state';
import { getModelCapabilities } from '../ai/platform-factory';
import type { UnifiedMessage, UnifiedContentPart, ModelCapabilities } from '../ai/types';

/**
 * Build context from a single message
 */
const buildMessageContent = async (
    msg: ContextMessage,
): Promise<UnifiedMessage> => {
    // Get file contents if message has a file
    const fileContents = msg.file
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
    const fileContents = msg.file
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
    const opts: BuildContextOptions = options && 'excludeMessageIds' in options
        ? options
        : { capabilities: options as ModelCapabilities | undefined };

    // Get capabilities for current model if not provided
    const modelCapabilities = opts.capabilities ?? getModelCapabilities(getCurrentModel());

    // Build context array
    const chatContents: UnifiedMessage[] = [];

    // Get history messages (excluding current message)
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
