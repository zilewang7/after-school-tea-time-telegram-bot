/**
 * Context-related database queries
 * Handles both Message table (user messages) and BotResponse table (bot messages)
 */
import { Op } from '@sequelize/core';
import { getMessage, getBotResponse, findBotResponseByMessageId, BotResponse } from '../index.js';
import { getCachedMedia } from '../../services/media-cache-service.js';
import { backfillMessages, isMessageBackfillEnabled } from '../../services/message-backfill-service.js';
import { isRecentSummonCommand } from '../../reply/commands/chat-command-parser.js';
import { isVideoMediaHint } from '../../reply/media-hint.js';
import { Message } from '../messageDTO.js';
import type { StoredWidget } from '../botResponseDTO.js';
import { MessageLink } from '../messageLinkDTO.js';
import { listExcludedMessageIds } from './context-exclusions.js';
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
    /**
     * The message is in the context for its words only: its media is
     * deliberately left out (a video `/chat r` pulled in). Set while the reply
     * tree is assembled, never stored.
     */
    mediaOmitted: boolean;
    /**
     * A chat member took this message out of the model's context (panel).
     * Only set when a caller asks to keep excluded messages (the panel's tree
     * view); the reply path never sees them at all.
     */
    excludedFromContext?: boolean;
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
    mediaOmitted: false,
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

/** One level of children, plus which of them a `/chat r` attached */
export interface ChildMessages {
    /** Every child, ascending by message id */
    ids: number[];
    /**
     * Children attached through a `/chat r` summon. Their video media stays out
     * of the context — the command asked for the conversation, not its videos.
     */
    recentLinkedIds: number[];
}

/**
 * All children of the given messages, chronologically: their replies (derived
 * from the children's own `replyToId`) plus everything `/chat` pulled in. Both
 * halves are one query each, so a whole tree level costs two queries.
 *
 * `commandByMessageId` supplies the stored `/chat` spec of the parent messages,
 * which is what tells a `/chat r` link apart from the others.
 */
export const findChildMessages = async (
    chatId: number,
    parentIds: number[],
    commandByMessageId: ReadonlyMap<number, string | null> = new Map()
): Promise<ChildMessages> => {
    if (!parentIds.length) return { ids: [], recentLinkedIds: [] };
    const [replyChildren, linked] = await Promise.all([
        findReplyChildIds(chatId, parentIds),
        getLinkedMessageIds(chatId, parentIds),
    ]);
    const ids = new Set<number>(replyChildren);
    const recentLinkedIds = new Set<number>();
    for (const [sourceMessageId, linkedMessageIds] of linked) {
        const fromRecentSummon = isRecentSummonCommand(commandByMessageId.get(sourceMessageId) ?? null);
        for (const linkedMessageId of linkedMessageIds) {
            ids.add(linkedMessageId);
            if (fromRecentSummon) recentLinkedIds.add(linkedMessageId);
        }
    }
    return {
        ids: [...ids].sort((a, b) => a - b),
        recentLinkedIds: [...recentLinkedIds],
    };
};

/** Children of the given messages, ids only */
export const findChildMessageIds = async (
    chatId: number,
    parentIds: number[]
): Promise<number[]> => (await findChildMessages(chatId, parentIds)).ids;

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
            mediaOmitted: false,
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
            mediaOmitted: false,
        };
    }

    return null;
};

/**
 * Stored message rows by id, in one query: reply targets that fall outside the
 * panel's tree (a message answering something older than the conversation).
 * Ids with no row are simply absent from the result, never an error.
 */
export const listContextMessagesByIds = async (
    chatId: number,
    messageIds: readonly number[]
): Promise<ContextMessage[]> => {
    if (messageIds.length === 0) return [];
    const rows = await Message.findAll({
        where: { chatId, messageId: { [Op.in]: [...messageIds] } },
    });
    return rows.map(toContextMessage);
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

/** How a reply chain is read */
export interface RootLookupOptions {
    /**
     * false: a missing row is a dead end, never backfilled from luoxu (the
     * panel reads trees without writing). Default true.
     */
    recover?: boolean;
    /**
     * Rows already read, by message id, shared across several lookups of one
     * batch (the panel's conversation list climbs many chains of one chat).
     * Only meant for read-only lookups.
     */
    cache?: Map<number, ContextMessage | null>;
}

/** getContextMessage through the batch cache, when there is one */
const readChainLink = async (
    chatId: number,
    messageId: number,
    cache: Map<number, ContextMessage | null> | undefined
): Promise<ContextMessage | null> => {
    if (cache === undefined) return getContextMessage(chatId, messageId);
    const known = cache.get(messageId);
    if (known !== undefined) return known;
    const read = await getContextMessage(chatId, messageId);
    cache.set(messageId, read);
    return read;
};

/**
 * Find the root message of a reply chain
 */
export const findRootMessage = async (
    chatId: number,
    messageId: number,
    options: RootLookupOptions = {}
): Promise<ContextMessage | null> => {
    const recover = options.recover ?? true;
    let currentMessage: ContextMessage | null = null;

    const findRoot = async (msgId: number): Promise<ContextMessage | null> => {
        // Only the ids the chain points at are recovered: a reply target is
        // known to exist, so a missing row is a hole worth repairing.
        const msg = msgId === messageId || !recover
            ? await readChainLink(chatId, msgId, options.cache)
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
    visited: Set<number>,
    recover: boolean
): Promise<void> => {
    let level = [rootId];
    // Already-collected `/chat` rows: their links decide which children keep
    // their video media
    const commandByMessageId = new Map<number, string | null>(
        collected.map((message) => [message.messageId, message.chatCommand])
    );
    const recentLinkedIds = new Set<number>();

    while (level.length) {
        const children = await findChildMessages(chatId, level, commandByMessageId);
        children.recentLinkedIds.forEach((childId) => recentLinkedIds.add(childId));
        const childIds = children.ids.filter((childId) => !visited.has(childId));
        const nextLevel: number[] = [];

        for (const childId of childIds) {
            visited.add(childId);
            try {
                // A child id comes either from a reply row (which exists by
                // definition) or from a /chat link, whose target may have been
                // lost — recover that one too (unless the caller only reads).
                const msg = recover
                    ? await getContextMessageOrRecover(chatId, childId)
                    : await getContextMessage(chatId, childId);
                if (msg) {
                    collected.push(msg);
                    commandByMessageId.set(childId, msg.chatCommand);
                    nextLevel.push(childId);
                }
            } catch (error) {
                console.error('[context-queries] Error collecting reply:', error);
            }
        }

        level = nextLevel;
    }

    // Landed after the walk: one message can be reached by several edges, and
    // whether its media is left out depends on the message, not on which edge
    // found it first
    for (const message of collected) {
        if (recentLinkedIds.has(message.messageId) && isVideoMediaHint(message.mediaHint)) {
            message.mediaOmitted = true;
        }
    }
};

/**
 * Every message id a reply tree contains: its replies at every depth plus the
 * `/chat` pulls hanging off any of them. Ids only — no row bodies and no media
 * bytes — so a share's media route can check membership cheaply.
 *
 * The set can name a row that no longer exists (a lost `/chat` target); callers
 * that need content still read the row and degrade on null.
 */
export const listConversationMessageIds = async (chatId: number, rootId: number): Promise<Set<number>> => {
    const visited = new Set<number>([rootId]);
    let level = [rootId];
    while (level.length > 0) {
        const childIds = await findChildMessageIds(chatId, level);
        const nextLevel = childIds.filter((childId) => !visited.has(childId));
        for (const childId of nextLevel) visited.add(childId);
        level = nextLevel;
    }
    return visited;
};

/**
 * The chat's excluded message ids (panel). A failed read must not cost the
 * reply itself, so it degrades to "nothing excluded" with a log line.
 */
export const loadContextExclusions = async (chatId: number): Promise<ReadonlySet<number>> => {
    try {
        return await listExcludedMessageIds(chatId);
    } catch (error) {
        console.error('[context-queries] context exclusions unavailable, none applied:', error);
        return new Set();
    }
};

export interface RepliesHistoryOptions {
    /** Leave out the message the history was asked for */
    excludeSelf?: boolean;
    /** false: read-only walk, missing rows are never backfilled (panel). Default true */
    recover?: boolean;
    /**
     * Keep the messages excluded from the context, flagged with
     * `excludedFromContext` (the panel's tree view). Default false: they are
     * left out.
     */
    includeExcluded?: boolean;
    /** The chat's exclusions, when the caller has already read them */
    exclusions?: ReadonlySet<number>;
}

/**
 * Get the complete reply history for a message
 * Returns all messages in the reply chain, sorted by messageId
 */
export const getRepliesHistory = async (
    chatId: number,
    messageId: number,
    options: RepliesHistoryOptions = {}
): Promise<ContextMessage[]> => {
    const { excludeSelf, includeExcluded = false } = options;
    const recover = options.recover ?? true;
    const messageList: ContextMessage[] = [];

    // Find the root message
    const rootMessage = await findRootMessage(chatId, messageId, { recover });
    if (!rootMessage) return [];

    messageList.push(rootMessage);

    // Collect all replies
    await collectDescendants(
        chatId,
        rootMessage.messageId,
        messageList,
        new Set([rootMessage.messageId]),
        recover
    );

    // The message a `/chat r` walked back from is the newest of that burst, so
    // its video stays out of this one reply too. Deliberately not persistent:
    // a later message answering the same video is an ordinary question, not a
    // `/chat r`, and must still see it.
    const trigger = messageList.find((message) => message.messageId === messageId);
    if (trigger && trigger.replyToId !== null && isRecentSummonCommand(trigger.chatCommand)) {
        const anchor = messageList.find((message) => message.messageId === trigger.replyToId);
        if (anchor && isVideoMediaHint(anchor.mediaHint)) {
            anchor.mediaOmitted = true;
        }
    }

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

    // Messages excluded from the context go after deduplication and before
    // sorting. The walk above is unaffected: their replies and whatever their
    // links brought in are still collected.
    const exclusions = options.exclusions ?? (await loadContextExclusions(chatId));
    const kept = filtered.filter((msg) => {
        if (!exclusions.has(msg.messageId)) return true;
        if (!includeExcluded) return false;
        msg.excludedFromContext = true;
        return true;
    });

    // Sort by messageId
    kept.sort((a, b) => a.messageId - b.messageId);

    return kept;
};

/* ------------------------------------------------------------------ *
 * Widgets a context replays
 * ------------------------------------------------------------------ */

/** What a context replay needs of a stored widget: its mode and A2UI source */
export interface WidgetSurfaceInfo {
    readonly mode: 'a2ui' | 'html';
    /** The A2UI source the model sent, when mode is a2ui */
    readonly surface?: unknown;
}

/** Runtime guard: the versions column is JSON that can predate or outlive the type */
const isStoredWidget = (value: unknown): value is StoredWidget =>
    typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    (value.mode === 'a2ui' || value.mode === 'html');

/**
 * The widget each of these bot messages carried, keyed by the reply's first
 * message id (the row a bot reply is stored under).
 *
 * Only the widget rows of a context are asked for, and only the current version
 * is read: the versions column also carries every image and file of every
 * version as base64, so nothing is loaded for messages without a card.
 * Missing or malformed entries are skipped, never thrown.
 */
export const loadWidgetSurfaces = async (
    chatId: number,
    messageIds: readonly number[]
): Promise<Map<number, WidgetSurfaceInfo>> => {
    const byMessageId = new Map<number, WidgetSurfaceInfo>();
    if (!messageIds.length) return byMessageId;

    const responses = await BotResponse.findAll({
        where: { chatId, messageId: { [Op.in]: [...new Set(messageIds)] } },
        attributes: ['messageId', 'currentVersionIndex', 'versions'],
    });

    for (const response of responses) {
        const version = response.getVersions()[response.currentVersionIndex];
        const widget: unknown = version?.widget;
        if (!isStoredWidget(widget)) continue;
        byMessageId.set(response.messageId, {
            mode: widget.mode,
            ...(widget.surface === undefined ? {} : { surface: widget.surface }),
        });
    }

    return byMessageId;
};

/* ------------------------------------------------------------------ *
 * Bot replies of a chat, for the panel
 * ------------------------------------------------------------------ */

/**
 * A reply without its versions: the versions column carries every image and
 * file of every version as base64, so listings read only these columns.
 */
export interface ReplyHead {
    /** First message id */
    messageId: number;
    userMessageId: number;
    createdAt: Date;
    /** Last write: finalize, version switch, button state */
    updatedAt: Date;
}

const REPLY_HEAD_ATTRIBUTES: Array<'messageId' | 'userMessageId' | 'createdAt' | 'updatedAt'> = [
    'messageId',
    'userMessageId',
    'createdAt',
    'updatedAt',
];

const toReplyHead = (response: BotResponse): ReplyHead => {
    const createdAt = response.createdAt ?? new Date(0);
    return {
        messageId: response.messageId,
        userMessageId: response.userMessageId,
        createdAt,
        updatedAt: response.updatedAt ?? createdAt,
    };
};

/** Every reply of a chat created at or after `since`, oldest first, without versions */
export const listReplyHeadsSince = async (chatId: number, since: Date): Promise<ReplyHead[]> =>
    (
        await BotResponse.findAll({
            where: { chatId, createdAt: { [Op.gte]: since } },
            attributes: REPLY_HEAD_ATTRIBUTES,
            order: [['messageId', 'ASC']],
        })
    ).map(toReplyHead);

/** The replies answering any of `userMessageIds`, oldest first, without versions */
export const listReplyHeadsForUserMessages = async (
    chatId: number,
    userMessageIds: readonly number[]
): Promise<ReplyHead[]> => {
    if (!userMessageIds.length) return [];
    return (
        await BotResponse.findAll({
            where: { chatId, userMessageId: { [Op.in]: [...userMessageIds] } },
            attributes: REPLY_HEAD_ATTRIBUTES,
            order: [['messageId', 'ASC']],
        })
    ).map(toReplyHead);
};

/**
 * One reply by its first message id, only when it belongs to `chatId`: the
 * table's primary key is the message id alone, so another chat's reply can
 * carry the same id and must not be served instead.
 */
export const findBotResponseInChat = async (chatId: number, firstMessageId: number): Promise<BotResponse | null> => {
    const response = await BotResponse.findByPk(firstMessageId);
    return response !== null && response.chatId === chatId ? response : null;
};

/** The stored replies with these first message ids, oldest first */
export const listBotResponsesByIds = async (
    chatId: number,
    firstMessageIds: readonly number[]
): Promise<BotResponse[]> => {
    if (!firstMessageIds.length) return [];
    return BotResponse.findAll({
        where: { chatId, messageId: { [Op.in]: [...firstMessageIds] } },
        order: [['messageId', 'ASC']],
    });
};

/**
 * Resolve the bytes + MIME for a message's file.
 * Prefers the content-addressed MediaCache (via fileUniqueId); falls back to
 * the legacy per-message `file` BLOB for older data / cache misses.
 * Returns null when the message carries no file.
 */
const MEDIA_URI_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches autoClear retention

/** Resolved media: inline bytes, a gs:// reference, or an expired GCS object. */
interface ResolvedMedia {
    bytes?: Buffer;
    fileUri?: string;
    expired?: boolean;
    sizeBytes?: number | null;
    durationSeconds?: number | null;
    mime: string | null;
    kind: string | null;
}

const resolveFileBytes = async (msg: Message): Promise<ResolvedMedia | null> => {
    if (msg.fileUniqueId) {
        const cached = await getCachedMedia(msg.fileUniqueId);
        if (cached) {
            if (cached.fileUri) {
                // Large media in GCS. Past the TTL autoClear has (or soon will) delete
                // the object, so mark expired rather than feed a dead gs://.
                const ageMs = Date.now() - new Date(cached.createdAt).getTime();
                if (ageMs > MEDIA_URI_TTL_MS) {
                    return { expired: true, sizeBytes: cached.sizeBytes, durationSeconds: cached.durationSeconds, mime: cached.mime, kind: cached.kind };
                }
                return { fileUri: cached.fileUri, sizeBytes: cached.sizeBytes, durationSeconds: cached.durationSeconds, mime: cached.mime, kind: cached.kind };
            }
            if (cached.data) {
                return { bytes: cached.data, sizeBytes: cached.sizeBytes ?? cached.data.length, durationSeconds: cached.durationSeconds, mime: cached.mime, kind: cached.kind };
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
            return { type: 'text', text: '[system] media expired (older than 7 days), not available' };
        }
        if (f.fileUri) {
            return {
                type: 'media',
                fileUri: f.fileUri,
                sizeBytes: f.sizeBytes ?? undefined,
                durationSeconds: f.durationSeconds ?? undefined,
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
            durationSeconds: f.durationSeconds ?? undefined,
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
