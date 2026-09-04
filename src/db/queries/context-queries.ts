/**
 * Context-related database queries
 * Handles both Message table (user messages) and BotResponse table (bot messages)
 */
import { Op } from '@sequelize/core';
import { getMessage, getBotResponse, findBotResponseByMessageId } from '../index.js';
import { getCachedMedia } from '../../services/media-cache-service.js';
import { backfillMessages, isMessageBackfillEnabled } from '../../services/message-backfill-service.js';
import { Message } from '../messageDTO.js';
import { MessageLink } from '../messageLinkDTO.js';
import type { UnifiedContentPart } from '../../ai/types.js';

const botUserName = process.env.BOT_NAME || 'Bot';

/**
 * Unified message interface for context building
 */
export interface ContextMessage {
    chatId: number;
    messageId: number;
    fromBotSelf: boolean;
    /** Author's Telegram user id; null on rows stored before it was recorded */
    userId: number | null;
    date: Date;
    userName: string;
    text: string | null;
    quoteText: string | null;
    file: Buffer | null;
    fileMime: string | null;
    fileUniqueId: string | null;
    replyToId: number | null;
    /** Serialized `/chat` parameters when this message is a `/chat` summon */
    chatCommand: string | null;
    modelParts: string | null;
    mediaHint: string | null;
    forwardOrigin: string | null;
    /** Original sender's user id for forwards without privacy protection */
    forwardFromId: number | null;
    /** Inline bot the message was sent via, e.g. "@gif" */
    viaBot: string | null;
    /** Text recognized in this message's images (models that can't see them) */
    ocrText: string | null;
}

/**
 * Project a stored message row onto the context-building shape
 */
export const toContextMessage = (msg: Message): ContextMessage => ({
    chatId: msg.chatId,
    messageId: msg.messageId,
    fromBotSelf: msg.fromBotSelf,
    userId: msg.userId,
    date: msg.date,
    userName: msg.userName,
    text: msg.text,
    quoteText: msg.quoteText,
    file: msg.file,
    fileMime: msg.fileMime,
    fileUniqueId: msg.fileUniqueId,
    replyToId: msg.replyToId,
    chatCommand: msg.chatCommand,
    modelParts: msg.modelParts,
    mediaHint: msg.mediaHint,
    forwardOrigin: msg.forwardOrigin,
    forwardFromId: msg.forwardFromId,
    viaBot: msg.viaBot,
    ocrText: msg.ocrText,
});

/**
 * Ids of the messages that reply to any of `parentIds`.
 *
 * `replyToId` is the source of truth for the reply tree: the child writes it
 * itself, in the same INSERT that creates the row, so it can never be lost or
 * clobbered. (A `replies` column on the parent used to mirror this, maintained
 * by a read-modify-write that raced with /chat and silently dropped messages —
 * see the reply-tree section of docs/2026-0731-1718.)
 */
export const findReplyChildIds = async (
    chatId: number,
    parentIds: number[]
): Promise<number[]> => {
    if (!parentIds.length) return [];
    const children = await Message.findAll({
        where: { chatId, replyToId: { [Op.in]: parentIds } },
        attributes: ['messageId'],
        order: [['messageId', 'ASC']],
    });
    return children.map((child) => child.messageId);
};

/**
 * The messages each of `sourceMessageIds` pulled into the context with `/chat`,
 * in one query. Sources with no links are absent from the map.
 */
export const getLinkedMessageIds = async (
    chatId: number,
    sourceMessageIds: number[]
): Promise<Map<number, number[]>> => {
    const bySource = new Map<number, number[]>();
    if (!sourceMessageIds.length) return bySource;

    const links = await MessageLink.findAll({
        where: { chatId, sourceMessageId: { [Op.in]: sourceMessageIds } },
        attributes: ['sourceMessageId', 'linkedMessageId'],
        order: [['linkedMessageId', 'ASC']],
    });

    for (const link of links) {
        const linked = bySource.get(link.sourceMessageId);
        if (linked) {
            linked.push(link.linkedMessageId);
        } else {
            bySource.set(link.sourceMessageId, [link.linkedMessageId]);
        }
    }
    return bySource;
};

/**
 * Record the messages a `/chat` command pulled into the context.
 *
 * Insert-only and idempotent: a repeated trigger for the same command hits the
 * unique index and is ignored, so no lock and no read-modify-write is involved,
 * and the target row does not even have to exist yet.
 */
export const saveMessageLinks = async (
    chatId: number,
    sourceMessageId: number,
    linkedMessageIds: number[]
): Promise<void> => {
    if (!linkedMessageIds.length) return;
    await MessageLink.bulkCreate(
        [...new Set(linkedMessageIds)].map((linkedMessageId) => ({
            chatId,
            sourceMessageId,
            linkedMessageId,
        })),
        { ignoreDuplicates: true }
    );
};

/**
 * All children of the given messages, chronologically: their replies (derived
 * from the children's own `replyToId`) plus everything `/chat` pulled in. Both
 * halves are one query each, so a whole tree level costs two queries.
 */
export const findChildMessageIds = async (
    chatId: number,
    parentIds: number[]
): Promise<number[]> => {
    if (!parentIds.length) return [];
    const [replyChildren, linked] = await Promise.all([
        findReplyChildIds(chatId, parentIds),
        getLinkedMessageIds(chatId, parentIds),
    ]);
    const merged = new Set<number>([...replyChildren, ...[...linked.values()].flat()]);
    return [...merged].sort((a, b) => a - b);
};

/** Children of a single message (see findChildMessageIds) */
export const getChildMessageIds = async (
    chatId: number,
    messageId: number
): Promise<number[]> => findChildMessageIds(chatId, [messageId]);

/**
 * Get a message from either Message table or BotResponse table
 * This allows context to include bot responses
 */
export const getContextMessage = async (
    chatId: number,
    messageId: number
): Promise<ContextMessage | null> => {
    // First try Message table
    const msg = await getMessage(chatId, messageId);
    if (msg) {
        return toContextMessage(msg);
    }

    // Try BotResponse table
    const botResponse = await getBotResponse(chatId, messageId);
    if (botResponse) {
        const currentVersion = botResponse.getCurrentVersion();
        return {
            chatId: botResponse.chatId,
            messageId: botResponse.messageId,
            fromBotSelf: true,
            userId: null,
            date: new Date(currentVersion?.createdAt || Date.now()),
            userName: botUserName,
            text: currentVersion?.text || null,
            quoteText: null,
            file: null,
            fileMime: null,
            fileUniqueId: null,
            replyToId: botResponse.userMessageId,
            chatCommand: null, // the bot never issues /chat
            modelParts: currentVersion?.modelParts ? JSON.stringify(currentVersion.modelParts) : null,
            mediaHint: null,
            forwardOrigin: null,
            forwardFromId: null,
            viaBot: null,
            ocrText: null,
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
            userId: null,
            date: new Date(currentVersion?.createdAt || Date.now()),
            userName: botUserName,
            text: currentVersion?.text || null,
            quoteText: null,
            file: null,
            fileMime: null,
            fileUniqueId: null,
            replyToId: foundResponse.userMessageId,
            chatCommand: null,
            modelParts: currentVersion?.modelParts ? JSON.stringify(currentVersion.modelParts) : null,
            mediaHint: null,
            forwardOrigin: null,
            forwardFromId: null,
            viaBot: null,
            ocrText: null,
        };
    }

    return null;
};

/**
 * Read a message, and if its row is missing, try to recover it from Telegram
 * first. A hole here truncates the whole chain above it, which is how a reply to
 * a message we failed to store ends up with no context at all.
 */
export const getContextMessageOrRecover = async (
    chatId: number,
    messageId: number
): Promise<ContextMessage | null> => {
    const stored = await getContextMessage(chatId, messageId);
    if (stored || !isMessageBackfillEnabled()) return stored;

    const recovered = await backfillMessages(chatId, [messageId]);
    if (recovered.length === 0) return null;
    return getContextMessage(chatId, messageId);
};

/**
 * Find the root message of a reply chain
 */
export const findRootMessage = async (
    chatId: number,
    messageId: number
): Promise<ContextMessage | null> => {
    let currentMessage: ContextMessage | null = null;

    const findRoot = async (msgId: number): Promise<ContextMessage | null> => {
        // Only the ids the chain points at are recovered: a reply target is
        // known to exist, so a missing row is a hole worth repairing.
        const msg = msgId === messageId
            ? await getContextMessage(chatId, msgId)
            : await getContextMessageOrRecover(chatId, msgId);

        if (msg?.replyToId) {
            currentMessage = msg;
            return findRoot(msg.replyToId);
        }

        return msg ?? currentMessage;
    };

    return findRoot(messageId);
};

/**
 * Collect everything hanging off a message: its replies, their replies, and the
 * bystanders `/chat` pulled in along the way.
 *
 * Walked level by level so one whole level costs two queries (reverse reply
 * lookup + links) instead of two per node. `visited` guards against cycles:
 * reply relations always point backwards in time, but /chat can attach an
 * ancestor to its own descendant, which would otherwise loop forever.
 */
const collectDescendants = async (
    chatId: number,
    rootId: number,
    collected: ContextMessage[],
    visited: Set<number>
): Promise<void> => {
    let level = [rootId];

    while (level.length) {
        const childIds = (await findChildMessageIds(chatId, level)).filter(
            (childId) => !visited.has(childId)
        );
        const nextLevel: number[] = [];

        for (const childId of childIds) {
            visited.add(childId);
            try {
                // A child id comes either from a reply row (which exists by
                // definition) or from a /chat link, whose target may have been
                // lost — recover that one too.
                const msg = await getContextMessageOrRecover(chatId, childId);
                if (msg) {
                    collected.push(msg);
                    nextLevel.push(childId);
                }
            } catch (error) {
                console.error('[context-queries] Error collecting reply:', error);
            }
        }

        level = nextLevel;
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
    await collectDescendants(
        chatId,
        rootMessage.messageId,
        messageList,
        new Set([rootMessage.messageId])
    );

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
    sizeBytes?: number | null;
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
                    return { expired: true, sizeBytes: cached.sizeBytes, mime: cached.mime, kind: cached.kind };
                }
                return { fileUri: cached.fileUri, sizeBytes: cached.sizeBytes, mime: cached.mime, kind: cached.kind };
            }
            if (cached.data) {
                return { bytes: cached.data, sizeBytes: cached.sizeBytes ?? cached.data.length, mime: cached.mime, kind: cached.kind };
            }
        }
    }
    if (msg.file) {
        return { bytes: msg.file, sizeBytes: msg.file.length, mime: msg.fileMime, kind: null };
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

    const childIds = await getChildMessageIds(chatId, messageId);
    if (!hasFileRef(message) && !childIds.length) return [];

    const files: ResolvedMedia[] = [];

    // Add main message file
    const mainFile = await resolveFileBytes(message);
    if (mainFile) {
        files.push(mainFile);
    }

    // Collect sub-image files, sorted by messageId to ensure correct order
    // (Telegram media group updates may arrive out of order)
    const subImages: (ResolvedMedia & { messageId: number })[] = [];
    for (const replyId of childIds) {
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
                sizeBytes: f.sizeBytes ?? undefined,
                mimeType: f.mime ?? 'application/octet-stream',
                mediaKind: f.kind ?? undefined,
            };
        }
        const { mime, kind } = f;
        const bytes = f.bytes ?? Buffer.alloc(0);
        const base64 = bytes.toString('base64');
        if (mime === null || mime.startsWith('image/')) {
            return {
                type: 'image',
                imageData: base64,
                sizeBytes: f.sizeBytes ?? bytes.length,
                mimeType: mime ?? 'image/png',
                // Kept on images too: a static sticker is an image, and the
                // context builder needs the kind to nudge about its pack emoji
                mediaKind: f.kind ?? undefined,
            };
        }
        return {
            type: 'media',
            mediaData: base64,
            sizeBytes: f.sizeBytes ?? bytes.length,
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

    const childIds = await getChildMessageIds(chatId, messageId);
    for (const replyId of childIds) {
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
