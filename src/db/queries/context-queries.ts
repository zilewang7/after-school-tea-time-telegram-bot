/**
 * Context-related database queries
 * Migrated from reply/helper.ts
 */
import { getMessage } from '../index';
import { Message } from '../messageDTO';
import type { UnifiedContentPart } from '../../ai/types';

/**
 * Find the root message of a reply chain
 */
const findRootMessage = async (
    chatId: number,
    messageId: number
): Promise<Message | null> => {
    let currentMessage: Message | null = null;

    const findRoot = async (msgId: number): Promise<Message | null> => {
        const msg = await getMessage(chatId, msgId);

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
    message: Message,
    collected: Message[]
): Promise<void> => {
    const repliesIds: number[] = JSON.parse(message.replies);

    if (!repliesIds.length) return;

    for (const replyId of repliesIds) {
        try {
            const msg = await getMessage(chatId, replyId);
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
): Promise<Message[]> => {
    const { excludeSelf } = options;
    const messageList: Message[] = [];

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
