/**
 * Context-related database queries
 * Handles both Message table (user messages) and BotResponse table (bot messages)
 */
import { getMessage, getBotResponse, findBotResponseByMessageId } from '../index';
import type { UnifiedContentPart } from '../../ai/types';

const botUserName = process.env.BOT_NAME || 'Bot';

/**
 * Unified message interface for context building
 */
export interface ContextMessage {
    chatId: number;
    messageId: number;
    fromBotSelf: boolean;
    date: Date;
    userName: string;
    text: string | null;
    quoteText: string | null;
    file: Buffer | null;
    replyToId: number | null;
    replies: string;
    modelParts: string | null;
}

/**
 * Get a message from either Message table or BotResponse table
 * This allows context to include bot responses
 */
const getContextMessage = async (
    chatId: number,
    messageId: number
): Promise<ContextMessage | null> => {
    // First try Message table
    const msg = await getMessage(chatId, messageId);
    if (msg) {
        return {
            chatId: msg.chatId,
            messageId: msg.messageId,
            fromBotSelf: msg.fromBotSelf,
            date: msg.date,
            userName: msg.userName,
            text: msg.text,
            quoteText: msg.quoteText,
            file: msg.file,
            replyToId: msg.replyToId,
            replies: msg.replies,
            modelParts: msg.modelParts,
        };
    }

    // Try BotResponse table
    const botResponse = await getBotResponse(chatId, messageId);
    if (botResponse) {
        const currentVersion = botResponse.getCurrentVersion();
        return {
            chatId: botResponse.chatId,
            messageId: botResponse.messageId,
            fromBotSelf: true,
            date: new Date(currentVersion?.createdAt || Date.now()),
            userName: botUserName,
            text: currentVersion?.text || null,
            quoteText: null,
            file: null,
            replyToId: botResponse.userMessageId,
            replies: '[]', // Bot responses don't track replies the same way
            modelParts: currentVersion?.modelParts ? JSON.stringify(currentVersion.modelParts) : null,
        };
    }

    // Also search by message ID in case it's a continuation message
    const foundResponse = await findBotResponseByMessageId(chatId, messageId);
    if (foundResponse) {
        const currentVersion = foundResponse.getCurrentVersion();
        return {
            chatId: foundResponse.chatId,
            messageId: foundResponse.messageId,
            fromBotSelf: true,
            date: new Date(currentVersion?.createdAt || Date.now()),
            userName: botUserName,
            text: currentVersion?.text || null,
            quoteText: null,
            file: null,
            replyToId: foundResponse.userMessageId,
            replies: '[]',
            modelParts: currentVersion?.modelParts ? JSON.stringify(currentVersion.modelParts) : null,
        };
    }

    return null;
};

/**
 * Find the root message of a reply chain
 */
const findRootMessage = async (
    chatId: number,
    messageId: number
): Promise<ContextMessage | null> => {
    let currentMessage: ContextMessage | null = null;

    const findRoot = async (msgId: number): Promise<ContextMessage | null> => {
        const msg = await getContextMessage(chatId, msgId);

        if (msg?.replyToId) {
            currentMessage = msg;
            return findRoot(msg.replyToId);
        }

        return msg ?? currentMessage;
    };

    return findRoot(messageId);
};

/**
 * Recursively collect all replies to a message
 */
const collectReplies = async (
    chatId: number,
    message: ContextMessage,
    collected: ContextMessage[]
): Promise<void> => {
    const repliesIds: number[] = JSON.parse(message.replies);

    if (!repliesIds.length) return;

    for (const replyId of repliesIds) {
        try {
            const msg = await getContextMessage(chatId, replyId);
            if (msg) {
                collected.push(msg);
                await collectReplies(chatId, msg, collected);
            }
        } catch (error) {
            console.error('[context-queries] Error collecting reply:', error);
        }
    }
};

/**
 * Get the complete reply history for a message
 * Returns all messages in the reply chain, sorted by messageId
 */
export const getRepliesHistory = async (
    chatId: number,
    messageId: number,
    options: { excludeSelf?: boolean } = {}
): Promise<ContextMessage[]> => {
    const { excludeSelf } = options;
    const messageList: ContextMessage[] = [];

    // Find the root message
    const rootMessage = await findRootMessage(chatId, messageId);
    if (!rootMessage) return [];

    messageList.push(rootMessage);

    // Collect all replies
    await collectReplies(chatId, rootMessage, messageList);

    // Deduplicate and filter
    const seen = new Set<number>();
    const filtered = messageList.filter((msg) => {
        if (seen.has(msg.messageId)) return false;
        if (excludeSelf && msg.messageId === messageId) return false;
        // Filter out "sub image" messages
        if (msg.text && /sub image of \[(\w+)\]/.test(msg.text)) return false;

        seen.add(msg.messageId);
        return true;
    });

    // Sort by messageId
    filtered.sort((a, b) => a.messageId - b.messageId);

    return filtered;
};

/**
 * Get file contents (images) from a message and its sub-images
 */
export const getFileContentsOfMessage = async (
    chatId: number,
    messageId: number
): Promise<UnifiedContentPart[]> => {
    const message = await getMessage(chatId, messageId);
    if (!message) return [];

    const repliesIds: number[] = JSON.parse(message.replies);
    if (!message.file && !repliesIds.length) return [];

    const files: Buffer[] = [];

    // Add main message file
    if (message.file) {
        files.push(message.file);
    }

    // Add sub-image files
    for (const replyId of repliesIds) {
        const msg = await getMessage(chatId, replyId);
        if (
            msg?.file &&
            msg.text?.match(/sub image of \[(\w+)\]/)?.[1] === String(messageId)
        ) {
            files.push(msg.file);
        }
    }

    // Convert to UnifiedContentPart format
    return files.map((file) => ({
        type: 'image' as const,
        imageData: file.toString('base64'),
    }));
};

/**
 * Check if a message has any associated files
 */
export const messageHasFiles = async (
    chatId: number,
    messageId: number
): Promise<boolean> => {
    const message = await getMessage(chatId, messageId);
    if (!message) return false;

    if (message.file) return true;

    const repliesIds: number[] = JSON.parse(message.replies);
    for (const replyId of repliesIds) {
        const msg = await getMessage(chatId, replyId);
        if (
            msg?.file &&
            msg.text?.match(/sub image of \[(\w+)\]/)?.[1] === String(messageId)
        ) {
            return true;
        }
    }

    return false;
};
