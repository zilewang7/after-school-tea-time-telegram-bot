/**
 * Context-related database queries
 * Handles both Message table (user messages) and BotResponse table (bot messages)
 */
import { getMessage, getBotResponse, findBotResponseByMessageId } from '../index.js';
import { getCachedMedia } from '../../services/media-cache-service.js';
import type { Message } from '../messageDTO.js';
import type { UnifiedContentPart } from '../../ai/types.js';

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
    fileMime: string | null;
    fileUniqueId: string | null;
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
            fileMime: msg.fileMime,
            fileUniqueId: msg.fileUniqueId,
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
            fileMime: null,
            fileUniqueId: null,
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
            fileMime: null,
            fileUniqueId: null,
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
 * Resolve the bytes + MIME for a message's file.
 * Prefers the content-addressed MediaCache (via fileUniqueId); falls back to
 * the legacy per-message `file` BLOB for older data / cache misses.
 * Returns null when the message carries no file.
 */
const MEDIA_URI_TTL_MS = 24 * 60 * 60 * 1000; // 1 day — matches autoClear + bucket lifecycle

/** Resolved media: inline bytes, a gs:// reference, or an expired GCS object. */
interface ResolvedMedia {
    bytes?: Buffer;
    fileUri?: string;
    expired?: boolean;
    mime: string | null;
    kind: string | null;
}

const resolveFileBytes = async (msg: Message): Promise<ResolvedMedia | null> => {
    if (msg.fileUniqueId) {
        const cached = await getCachedMedia(msg.fileUniqueId);
        if (cached) {
            if (cached.fileUri) {
                // Large media in GCS. Past the TTL the bucket lifecycle has (or soon
                // will) delete it, so mark expired rather than feed a dead gs://.
                const ageMs = Date.now() - new Date(cached.createdAt).getTime();
                if (ageMs > MEDIA_URI_TTL_MS) {
                    return { expired: true, mime: cached.mime, kind: cached.kind };
                }
                return { fileUri: cached.fileUri, mime: cached.mime, kind: cached.kind };
            }
            if (cached.data) {
                return { bytes: cached.data, mime: cached.mime, kind: cached.kind };
            }
        }
    }
    if (msg.file) {
        return { bytes: msg.file, mime: msg.fileMime, kind: null };
    }
    return null;
};

/** True if the message references a file (cached or legacy BLOB) */
const hasFileRef = (msg: Message): boolean => Boolean(msg.file || msg.fileUniqueId);

/**
 * Get file contents (images/audio/video) from a message and its sub-images
 */
export const getFileContentsOfMessage = async (
    chatId: number,
    messageId: number
): Promise<UnifiedContentPart[]> => {
    const message = await getMessage(chatId, messageId);
    if (!message) return [];

    const repliesIds: number[] = JSON.parse(message.replies);
    if (!hasFileRef(message) && !repliesIds.length) return [];

    const files: ResolvedMedia[] = [];

    // Add main message file
    const mainFile = await resolveFileBytes(message);
    if (mainFile) {
        files.push(mainFile);
    }

    // Collect sub-image files, sorted by messageId to ensure correct order
    // (Telegram media group updates may arrive out of order)
    const subImages: (ResolvedMedia & { messageId: number })[] = [];
    for (const replyId of repliesIds) {
        const msg = await getMessage(chatId, replyId);
        if (
            msg &&
            hasFileRef(msg) &&
            msg.text?.match(/sub image of \[(\w+)\]/)?.[1] === String(messageId)
        ) {
            const resolved = await resolveFileBytes(msg);
            if (resolved) {
                subImages.push({ messageId: replyId, ...resolved });
            }
        }
    }
    subImages.sort((a, b) => a.messageId - b.messageId);
    for (const sub of subImages) {
        files.push(sub);
    }

    // Convert to UnifiedContentPart format.
    // - expired GCS media → short text note (won't be fed to the model)
    // - gs:// reference → media part with fileUri (large media)
    // - inline bytes → image part (images / legacy null-mime) or media part
    return files.map((f): UnifiedContentPart => {
        if (f.expired) {
            return { type: 'text', text: '[system] media expired (older than 1 day), not available' };
        }
        if (f.fileUri) {
            return {
                type: 'media',
                fileUri: f.fileUri,
                mimeType: f.mime ?? 'application/octet-stream',
                mediaKind: f.kind ?? undefined,
            };
        }
        const { mime, kind } = f;
        const base64 = (f.bytes ?? Buffer.alloc(0)).toString('base64');
        if (mime === null || mime.startsWith('image/')) {
            return {
                type: 'image',
                imageData: base64,
                mimeType: mime ?? 'image/png',
            };
        }
        return {
            type: 'media',
            mediaData: base64,
            mimeType: mime,
            mediaKind: kind ?? undefined,
        };
    });
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

    if (hasFileRef(message)) return true;

    const repliesIds: number[] = JSON.parse(message.replies);
    for (const replyId of repliesIds) {
        const msg = await getMessage(chatId, replyId);
        if (
            msg &&
            hasFileRef(msg) &&
            msg.text?.match(/sub image of \[(\w+)\]/)?.[1] === String(messageId)
        ) {
            return true;
        }
    }

    return false;
};
