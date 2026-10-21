/**
 * TG message-link preview.
 *
 * A pasted `t.me/...` message link has no usable Telegram-side web preview
 * (luoxu /preview answers `none`), so the model used to see nothing but the URL.
 * This service resolves the link to its target message — our own database first,
 * luoxu's MTProto client second — and caches a small snapshot (target + the
 * message it replies to + the target's own media) that the context builder
 * injects into the user turn.
 *
 * The snapshot is URL-addressed like LinkPreviewCache and acquired in autoSave,
 * so building a context only ever reads caches and never blocks on the network.
 *
 * Unconfigured / unreachable luoxu degrades to whatever our database can serve.
 */
import { createHash } from 'node:crypto';
import { entitiesToMarkdown } from 'telegram-md-entities';
import type { MessageEntity } from 'grammy/types';
import { TgMessageLinkCache } from '../db/tgMessageLinkCacheDTO.js';
import { getContextMessage, getFileContentsOfMessage } from '../db/queries/context-queries.js';
import { getCachedMedia, putCachedMedia } from './media-cache-service.js';
import { isGcsEnabled, uploadBytesToGcs } from './gcs-service.js';
import { normalizeShortVideo } from './tgs-client.js';
import {
    extractTelegramMessageLinks,
    type ParsedTelegramMessageLink,
    type TelegramMessageLink,
} from '../reply/commands/telegram-message-link.js';
import type { ContextMessage } from '../db/queries/context-queries.js';
import type { UnifiedContentPart } from '../ai/types.js';

const luoxuBaseUrl = process.env.LUOXU_PREVIEW_URL;

/** At most this many links per message are resolved (more is not a link drop) */
const MAX_LINKS_PER_MESSAGE = 3;

/** How many link blocks may be injected into one assembled context */
const MAX_BLOCKS_PER_CONTEXT = 4;

/** Only this many of the newest blocks also carry their media */
const MAX_BLOCKS_WITH_MEDIA = 2;

/** Caps so one linked post cannot crowd out the conversation */
const MAX_TARGET_TEXT_CHARS = 4000;
const MAX_CONTEXT_TEXT_CHARS = 300;

/** Same boundary as autoSave: above this, bytes go to GCS instead of inline */
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

/** Memory/bandwidth cap for one linked media item */
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

/** gs:// references older than this are likely deleted (mirrors the preview path) */
const MEDIA_URI_TTL_MS = 24 * 60 * 60 * 1000;

const MESSAGES_TIMEOUT_MS = 5000;
const MEDIA_TIMEOUT_MS = 60000;

/** username → chat id lookups are cached: getChat is rate-limited (429 observed) */
const CHAT_CACHE_TTL_MS = 60 * 60 * 1000;
const CHAT_CACHE_MAX = 200;

/** Resolve `@username` to a chat via the Bot API */
export interface TgChatLookup {
    getChat(username: string): Promise<{ id: number; type: string; title?: string }>;
}

interface ResolvedChat {
    chatId: number;
    title: string | null;
}

export interface TgMessageLinkContext {
    /** Chat the linking message was posted in */
    chatId: number;
    chatTitle: string | null;
    /** The linking message itself: never resolved into itself */
    messageId: number;
    text: string;
}

/** One media item of the linked message, stored in MediaCache */
interface StoredMediaItem {
    partType: 'image' | 'media';
    mediaKind: string;
    mime: string;
    sizeBytes: number;
    durationSeconds: number | null;
    mediaKey: string;
}

/** One directly related message (the target's reply target) */
interface StoredContextItem {
    role: 'reply-to';
    messageId: number;
    senderName: string;
    /** ISO timestamp, null when Telegram did not report one */
    date: string | null;
    text: string;
}

interface ReadySnapshot {
    chatId: number;
    messageId: number;
    chatTitle: string | null;
    senderName: string;
    messageDate: Date | null;
    text: string;
    replyToId: number | null;
    contextItems: StoredContextItem[];
    source: 'db' | 'luoxu';
    mediaItems: StoredMediaItem[];
}

interface LuoxuMessageMedia {
    type: string;
    mime: string | null;
    size?: number | null;
    duration?: number | null;
}

interface LuoxuMessage {
    id: number;
    sender_name: string;
    text: string;
    entities: MessageEntity[];
    reply_to: number | null;
    date: number | null;
    media: LuoxuMessageMedia | null;
}

export interface TgMessageLinkPlanEntry {
    parsed: ParsedTelegramMessageLink;
    /** Within the media budget: its attachments may ride along */
    withMedia: boolean;
}

export type TgMessageLinkPlan = TgMessageLinkPlanEntry[];

const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};

const urlHash = (url: string): string =>
    createHash('sha256').update(url).digest('hex').slice(0, 24);

const mediaKeyFor = (url: string): string => `tg-message-link:${urlHash(url)}:media`;

const formatMessageDate = (date: Date | null): string => {
    if (!date || Number.isNaN(date.getTime())) return '时间未知';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: process.env.TZ || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const valueOf = (type: string): string =>
        parts.find((part) => part.type === type)?.value ?? '';
    return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}`;
};

/** Cap by codepoints so an emoji is never cut in half */
const truncateText = (text: string, maxChars: number): string => {
    const chars = Array.from(text);
    return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…（已截断）` : text;
};

/** Stored message text may still carry the context wire format's EOF marker */
const cleanStoredText = (text: string | null): string =>
    (text ?? '').replace(/<<EOF\s*$/, '').trim();

const parseJsonArray = <T>(serialized: string | null): T[] => {
    if (!serialized) return [];
    try {
        const parsed: unknown = JSON.parse(serialized);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const isLuoxuMessage = (value: unknown): value is LuoxuMessage => {
    if (typeof value !== 'object' || value === null) return false;
    return 'id' in value && typeof value.id === 'number';
};

const fetchLuoxuMessages = async (
    channelId: number,
    messageIds: number[]
): Promise<LuoxuMessage[]> => {
    if (!luoxuBaseUrl || messageIds.length === 0) return [];
    const url = `${luoxuBaseUrl}/messages?g=${channelId}&ids=${messageIds.join(',')}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(MESSAGES_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`luoxu /messages HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('messages' in payload)) {
        throw new Error('luoxu /messages returned an unexpected payload');
    }
    const { messages } = payload;
    return Array.isArray(messages) ? messages.filter(isLuoxuMessage) : [];
};

const fetchLuoxuMediaBytes = async (
    channelId: number,
    messageId: number
): Promise<Buffer | null> => {
    if (!luoxuBaseUrl) return null;
    const url = `${luoxuBaseUrl}/message-media?g=${channelId}&id=${messageId}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    // 404: no media; 413: over luoxu's cap — both degrade to a text-only block
    if (response.status === 404 || response.status === 413) return null;
    if (!response.ok) {
        throw new Error(`luoxu /message-media HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
};

/** Translate luoxu's media descriptor into what a media part needs */
const mediaKindOf = (type: string): 'image' | 'media' | null => {
    if (type === 'photo') return 'image';
    if (type === 'video' || type === 'animation' || type === 'audio' || type === 'voice') {
        return 'media';
    }
    return null;
};

/**
 * Download one linked media item into MediaCache (inline <=20MB, GCS above).
 * Returns null when the item cannot be stored (unreachable, too large without
 * GCS); the caller then keeps the text-only block.
 */
const storeLuoxuMedia = async (
    url: string,
    channelId: number,
    messageId: number,
    media: LuoxuMessageMedia
): Promise<StoredMediaItem | null> => {
    const partType = mediaKindOf(media.type);
    if (!partType) return null;
    if (media.size !== null && media.size !== undefined && media.size > MEDIA_MAX_BYTES) {
        console.log(`[tg-message-link] skip media of ${url} (${media.size} bytes > cap)`);
        return null;
    }

    const mediaKey = mediaKeyFor(url);
    const cached = await getCachedMedia(mediaKey);
    if (cached) {
        return {
            partType,
            mediaKind: cached.kind,
            mime: cached.mime,
            sizeBytes: cached.sizeBytes ?? media.size ?? 0,
            durationSeconds: cached.durationSeconds ?? media.duration ?? null,
            mediaKey,
        };
    }

    const bytes = await fetchLuoxuMediaBytes(channelId, messageId);
    if (!bytes || bytes.length === 0) return null;
    if (bytes.length > MEDIA_MAX_BYTES) {
        console.log(`[tg-message-link] skip media of ${url} (${bytes.length} bytes > cap)`);
        return null;
    }

    const mime = media.mime ?? 'application/octet-stream';
    // MediaCache.durationSeconds is an INTEGER: luoxu reports fractional seconds
    const durationSeconds = media.duration === null || media.duration === undefined
        ? null
        : Math.round(media.duration);

    if (bytes.length > INLINE_MAX_BYTES) {
        if (!isGcsEnabled()) return null;
        const fileUri = await uploadBytesToGcs(bytes, mediaKey, mime);
        await putCachedMedia({
            fileUniqueId: mediaKey,
            fileUri,
            sizeBytes: bytes.length,
            durationSeconds,
            mime,
            kind: media.type,
        });
        return {
            partType,
            mediaKind: media.type,
            mime,
            sizeBytes: bytes.length,
            durationSeconds,
            mediaKey,
        };
    }

    // Ultra-short clips need padding before Gemini accepts them; only the
    // inline lane converts (the GCS lane uploads bytes untouched, as in autoSave)
    const normalized = mime.startsWith('video/')
        ? await normalizeShortVideo(bytes, mime)
        : null;
    const finalBytes = normalized ? normalized.data : bytes;
    const finalMime = normalized ? normalized.mimeType : mime;

    await putCachedMedia({
        fileUniqueId: mediaKey,
        data: finalBytes,
        sizeBytes: finalBytes.length,
        durationSeconds,
        mime: finalMime,
        kind: media.type,
    });

    return {
        partType,
        mediaKind: media.type,
        mime: finalMime,
        sizeBytes: finalBytes.length,
        durationSeconds,
        mediaKey,
    };
};

const storeReadySnapshot = async (url: string, snapshot: ReadySnapshot): Promise<void> => {
    await TgMessageLinkCache.upsert({
        url,
        status: 'ready',
        source: snapshot.source,
        chatId: snapshot.chatId,
        messageId: snapshot.messageId,
        chatTitle: snapshot.chatTitle,
        senderName: snapshot.senderName,
        messageDate: snapshot.messageDate,
        text: snapshot.text,
        replyToId: snapshot.replyToId,
        contextItems: snapshot.contextItems.length ? JSON.stringify(snapshot.contextItems) : null,
        mediaItems: snapshot.mediaItems.length ? JSON.stringify(snapshot.mediaItems) : null,
        unavailableReason: null,
        lastUsedAt: new Date(),
    });
};

const storeUnavailable = async (url: string, reason: string): Promise<void> => {
    await TgMessageLinkCache.upsert({
        url,
        status: 'none',
        source: null,
        chatId: null,
        messageId: null,
        chatTitle: null,
        senderName: null,
        messageDate: null,
        text: null,
        replyToId: null,
        contextItems: null,
        mediaItems: null,
        unavailableReason: reason,
        lastUsedAt: new Date(),
    });
};

/** One stored message as the snapshot needs it */
interface SnapshotMessage {
    messageId: number;
    senderName: string;
    date: Date | null;
    text: string;
}

const snapshotMessageFromDb = (message: ContextMessage): SnapshotMessage => ({
    messageId: message.messageId,
    senderName: message.userName,
    date: message.date,
    text: cleanStoredText(message.text),
});

const snapshotMessageFromLuoxu = (message: LuoxuMessage): SnapshotMessage => {
    const text = message.entities.length
        ? entitiesToMarkdown({ text: message.text, entities: message.entities })
        : message.text;
    return {
        messageId: message.id,
        senderName: message.sender_name || '佚名',
        date: message.date === null ? null : new Date(message.date * 1000),
        text,
    };
};

/** Read the target and its reply target straight from our own database */
const buildSnapshotFromDb = async (
    chatId: number,
    messageId: number,
    chatTitle: string | null
): Promise<ReadySnapshot | null> => {
    const target = await getContextMessage(chatId, messageId);
    if (!target) return null;

    const contextItems: StoredContextItem[] = [];
    if (target.replyToId !== null) {
        const reply = await getContextMessage(chatId, target.replyToId);
        if (reply) {
            const snapshot = snapshotMessageFromDb(reply);
            contextItems.push({
                role: 'reply-to',
                messageId: snapshot.messageId,
                senderName: snapshot.senderName,
                date: snapshot.date === null ? null : snapshot.date.toISOString(),
                text: truncateText(snapshot.text, MAX_CONTEXT_TEXT_CHARS),
            });
        }
    }

    const snapshot = snapshotMessageFromDb(target);
    return {
        chatId,
        messageId,
        chatTitle,
        senderName: snapshot.senderName,
        messageDate: snapshot.date,
        text: truncateText(snapshot.text, MAX_TARGET_TEXT_CHARS),
        replyToId: target.replyToId,
        contextItems,
        source: 'db',
        mediaItems: [],
    };
};

/** Build the snapshot through luoxu when our database does not have the target */
const buildSnapshotFromLuoxu = async (
    chatId: number,
    messageId: number,
    chatTitle: string | null,
    url: string
): Promise<ReadySnapshot | null> => {
    const channelId = toLuoxuChannelId(chatId);
    if (channelId === null) return null;

    const messages = await fetchLuoxuMessages(channelId, [messageId]);
    const targetMessage = messages.find((message) => message.id === messageId);
    if (!targetMessage) return null;

    const target = snapshotMessageFromLuoxu(targetMessage);

    const contextItems: StoredContextItem[] = [];
    if (targetMessage.reply_to !== null) {
        const replyMessages = await fetchLuoxuMessages(channelId, [targetMessage.reply_to]);
        const replyMessage = replyMessages.find((message) => message.id === targetMessage.reply_to);
        if (replyMessage) {
            const reply = snapshotMessageFromLuoxu(replyMessage);
            contextItems.push({
                role: 'reply-to',
                messageId: reply.messageId,
                senderName: reply.senderName,
                date: reply.date === null ? null : reply.date.toISOString(),
                text: truncateText(reply.text, MAX_CONTEXT_TEXT_CHARS),
            });
        }
    }

    const mediaItems: StoredMediaItem[] = [];
    if (targetMessage.media) {
        try {
            const stored = await storeLuoxuMedia(url, channelId, messageId, targetMessage.media);
            if (stored) mediaItems.push(stored);
        } catch (error) {
            console.error(
                `[tg-message-link] media download failed for ${url}:`,
                error instanceof Error ? error.message : error
            );
        }
    }

    return {
        chatId,
        messageId,
        chatTitle,
        senderName: target.senderName,
        messageDate: target.date,
        text: truncateText(target.text, MAX_TARGET_TEXT_CHARS),
        replyToId: targetMessage.reply_to,
        contextItems,
        source: 'luoxu',
        mediaItems,
    };
};

/** username → chat cache, with negative results so a bad link is not re-asked */
const resolvedChats = new Map<string, { value: ResolvedChat | null; expiresAt: number }>();

const peekResolvedChat = (username: string): ResolvedChat | null => {
    const cached = resolvedChats.get(username.toLowerCase());
    if (!cached || cached.expiresAt <= Date.now()) return null;
    return cached.value;
};

const rememberResolvedChat = (username: string, value: ResolvedChat | null): void => {
    const key = username.toLowerCase();
    if (resolvedChats.size >= CHAT_CACHE_MAX) {
        const oldest = resolvedChats.keys().next();
        if (!oldest.done) resolvedChats.delete(oldest.value);
    }
    resolvedChats.set(key, { value, expiresAt: Date.now() + CHAT_CACHE_TTL_MS });
};

const resolveTargetChat = async (
    lookup: TgChatLookup | null,
    context: TgMessageLinkContext,
    link: TelegramMessageLink
): Promise<ResolvedChat | null> => {
    if (link.chatRef.type === 'internal') {
        const chatId = link.chatRef.chatId;
        const title = chatId === context.chatId ? context.chatTitle : null;
        return { chatId, title };
    }

    const cached = peekResolvedChat(link.chatRef.username);
    if (cached) return cached;
    if (!lookup) return null;

    let resolved: ResolvedChat | null = null;
    try {
        const chat = await lookup.getChat(`@${link.chatRef.username}`);
        if (chat.type === 'channel' || chat.type === 'supergroup') {
            resolved = { chatId: chat.id, title: chat.title ?? null };
        }
    } catch (error) {
        console.error(
            `[tg-message-link] getChat failed for @${link.chatRef.username}:`,
            error instanceof Error ? error.message : error
        );
    }
    rememberResolvedChat(link.chatRef.username, resolved);
    return resolved;
};

/** In-flight acquisitions by URL, so concurrent triggers share one fetch */
const inflightAcquisitions = new Map<string, Promise<void>>();

const loadCachedRow = async (url: string): Promise<TgMessageLinkCache | null> => {
    const row = await TgMessageLinkCache.findByPk(url);
    if (!row) return null;
    row.lastUsedAt = new Date();
    row.save().catch((error) => {
        console.error('[tg-message-link] failed to refresh lastUsedAt:', error);
    });
    return row;
};

const doAcquire = async (
    lookup: TgChatLookup | null,
    context: TgMessageLinkContext,
    parsed: ParsedTelegramMessageLink
): Promise<void> => {
    const { url, link } = parsed;
    const target = await resolveTargetChat(lookup, context, link);
    if (!target) {
        await storeUnavailable(url, 'unsupported-chat');
        return;
    }

    // Our own database is always preferred: full fidelity and no network.
    const stored = await buildSnapshotFromDb(target.chatId, link.messageId, target.title);
    if (stored) {
        await storeReadySnapshot(url, stored);
        return;
    }

    if (!luoxuBaseUrl) return; // nothing else can answer; try again later

    try {
        const snapshot = await buildSnapshotFromLuoxu(
            target.chatId,
            link.messageId,
            target.title,
            url
        );
        if (!snapshot) {
            await storeUnavailable(url, 'not-found');
            return;
        }
        await storeReadySnapshot(url, snapshot);
        console.log(
            `[tg-message-link] cached ${url} ` +
            `(sender: ${snapshot.senderName}, reply-to: ${snapshot.replyToId ?? 'n/a'}, media: ${snapshot.mediaItems.length})`
        );
    } catch (error) {
        // Transient (network / 5xx): do not cache, the next message retries.
        console.error(
            `[tg-message-link] acquire failed for ${url}:`,
            error instanceof Error ? error.message : error
        );
    }
};

const acquireOne = async (
    lookup: TgChatLookup | null,
    context: TgMessageLinkContext,
    parsed: ParsedTelegramMessageLink
): Promise<void> => {
    const existing = await loadCachedRow(parsed.url);
    if (existing) return;

    const inflight = inflightAcquisitions.get(parsed.url);
    if (inflight) return inflight;

    const acquisition = doAcquire(lookup, context, parsed).catch((error) => {
        console.error('[tg-message-link] acquisition error:', error);
    });
    inflightAcquisitions.set(parsed.url, acquisition);
    void acquisition.then(
        () => inflightAcquisitions.delete(parsed.url),
        () => inflightAcquisitions.delete(parsed.url)
    );
    return acquisition;
};

const isSelfLink = (
    link: TelegramMessageLink,
    chatId: number,
    messageId: number
): boolean =>
    link.chatRef.type === 'internal' &&
    link.chatRef.chatId === chatId &&
    link.messageId === messageId;

const linksOf = (context: TgMessageLinkContext): ParsedTelegramMessageLink[] =>
    extractTelegramMessageLinks(context.text)
        .filter((parsed) => !isSelfLink(parsed.link, context.chatId, context.messageId))
        .slice(0, MAX_LINKS_PER_MESSAGE);

/**
 * Resolve every message link of one freshly stored message. Fire-and-forget from
 * autoSave/autoUpdate; never throws.
 */
export const acquireTgMessageLinkPreviews = async (
    lookup: TgChatLookup | null,
    context: TgMessageLinkContext
): Promise<void> => {
    for (const parsed of linksOf(context)) {
        await acquireOne(lookup, context, parsed);
    }
};

/**
 * Decide which messages get a link block and which of those keep their media.
 * Walks the context newest-first so the budget protects the current exchange
 * and drops the oldest historical links.
 */
export const planTgMessageLinkPreviews = (
    chatId: number,
    messages: ReadonlyArray<{ messageId: number; text: string | null }>,
    options: { maxBlocks?: number; maxWithMedia?: number } = {}
): Map<number, TgMessageLinkPlan> => {
    const maxBlocks = options.maxBlocks ?? MAX_BLOCKS_PER_CONTEXT;
    const maxWithMedia = options.maxWithMedia ?? MAX_BLOCKS_WITH_MEDIA;
    const plan = new Map<number, TgMessageLinkPlan>();
    let blocks = 0;

    for (let index = messages.length - 1; index >= 0 && blocks < maxBlocks; index -= 1) {
        const message = messages[index];
        if (!message) continue;
        const links = extractTelegramMessageLinks(message.text)
            .filter((parsed) => !isSelfLink(parsed.link, chatId, message.messageId))
            .slice(0, MAX_LINKS_PER_MESSAGE);
        if (!links.length) continue;

        const entries: TgMessageLinkPlan = [];
        for (const parsed of links) {
            if (blocks >= maxBlocks) break;
            entries.push({ parsed, withMedia: blocks < maxWithMedia });
            blocks += 1;
        }
        if (entries.length) plan.set(message.messageId, entries);
    }

    return plan;
};

/** Render the media items of a luoxu-sourced snapshot from MediaCache */
const cachedMediaPart = async (item: StoredMediaItem): Promise<UnifiedContentPart | null> => {
    const cached = await getCachedMedia(item.mediaKey);
    if (!cached) return null; // media expired (autoClear) → text-only degrade

    if (cached.fileUri) {
        const ageMs = Date.now() - new Date(cached.createdAt).getTime();
        if (ageMs > MEDIA_URI_TTL_MS) return null;
        return {
            type: 'media',
            fileUri: cached.fileUri,
            sizeBytes: cached.sizeBytes ?? item.sizeBytes,
            durationSeconds: cached.durationSeconds ?? item.durationSeconds ?? undefined,
            mimeType: cached.mime,
            mediaKind: item.mediaKind,
        };
    }

    if (!cached.data) return null;
    const base64 = cached.data.toString('base64');
    if (cached.mime.startsWith('image/')) {
        return {
            type: 'image',
            imageData: base64,
            sizeBytes: cached.sizeBytes ?? cached.data.length,
            mimeType: cached.mime,
            mediaKind: item.mediaKind,
        };
    }
    return {
        type: 'media',
        mediaData: base64,
        sizeBytes: cached.sizeBytes ?? cached.data.length,
        durationSeconds: cached.durationSeconds ?? item.durationSeconds ?? undefined,
        mimeType: cached.mime,
        mediaKind: item.mediaKind,
    };
};

/** The linked message's own media, read back from our stored message */
const dbMediaParts = async (chatId: number, messageId: number): Promise<UnifiedContentPart[]> => {
    const parts = await getFileContentsOfMessage(chatId, messageId);
    return parts.filter((part) => part.type === 'image' || part.type === 'media');
};

const mediaDescriptionOfParts = (parts: UnifiedContentPart[]): string | null => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const part of parts) {
        if (part.type === 'image') {
            images += 1;
            continue;
        }
        if (part.type !== 'media') continue;
        if (part.mimeType?.startsWith('video/')) videos += 1;
        if (part.mimeType?.startsWith('audio/')) audios += 1;
    }
    const labels: string[] = [];
    if (images) labels.push(`${images} 张图片`);
    if (videos) labels.push(`${videos} 个视频`);
    if (audios) labels.push(`${audios} 段音频`);
    return labels.length ? labels.join('、') : null;
};

const mediaDescriptionOfItems = (items: StoredMediaItem[]): string | null => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const item of items) {
        if (item.partType === 'image') images += 1;
        else if (item.mediaKind === 'video' || item.mediaKind === 'animation') videos += 1;
        else audios += 1;
    }
    const labels: string[] = [];
    if (images) labels.push(`${images} 张图片`);
    if (videos) labels.push(`${videos} 个视频`);
    if (audios) labels.push(`${audios} 段音频`);
    return labels.length ? labels.join('、') : null;
};

const buildReadyText = (
    url: string,
    snapshot: ReadySnapshot,
    mediaDescription: string | null,
    mediaIncluded: boolean
): string => {
    const titleLine = snapshot.chatTitle
        ? `[system] 消息链接预览：${url}（来自「${snapshot.chatTitle}」）`
        : `[system] 消息链接预览：${url}`;
    const lines = [
        titleLine,
        `--- 被链接的消息 · ${snapshot.senderName} · ${formatMessageDate(snapshot.messageDate)} ---`,
        snapshot.text.length ? snapshot.text : '（无文字）',
    ];

    for (const item of snapshot.contextItems) {
        const date = item.date === null ? null : new Date(item.date);
        lines.push(
            `--- 它回复的消息 · ${item.senderName} · ${formatMessageDate(date)} ---`,
            item.text.length ? item.text : '（无文字）'
        );
    }

    if (mediaDescription !== null) {
        const note = mediaIncluded
            ? `（见后续附件）`
            : `（本次未注入附件）`;
        lines.push(`[媒体] 被链接的消息附带 ${mediaDescription}${note}`);
    }

    return lines.join('\n');
};

const buildInContextNote = (url: string, contextNumber: number): UnifiedContentPart => ({
    type: 'text',
    text: `[system] 消息链接：${url} → 该消息已在本次上下文中，见 #${contextNumber}。`,
});

const describeUnavailable = (reason: string | null): string => {
    if (reason === 'unsupported-chat') return '链接指向的聊天不可访问';
    if (reason === 'not-found') return '消息不存在或已删除';
    return '抓取失败';
};

const renderCachedRow = async (
    url: string,
    row: TgMessageLinkCache,
    withMedia: boolean
): Promise<UnifiedContentPart[]> => {
    if (row.status !== 'ready' || row.chatId === null || row.messageId === null) {
        return [{
            type: 'text',
            text: `[system] 消息链接：${url}（读不到：${describeUnavailable(row.unavailableReason)}）`,
        }];
    }

    const snapshot: ReadySnapshot = {
        chatId: row.chatId,
        messageId: row.messageId,
        chatTitle: row.chatTitle,
        senderName: row.senderName ?? '佚名',
        messageDate: row.messageDate,
        text: row.text ?? '',
        replyToId: row.replyToId,
        contextItems: parseJsonArray<StoredContextItem>(row.contextItems),
        source: row.source === 'db' ? 'db' : 'luoxu',
        mediaItems: parseJsonArray<StoredMediaItem>(row.mediaItems),
    };

    const mediaParts: UnifiedContentPart[] = [];
    if (withMedia) {
        if (snapshot.source === 'db') {
            mediaParts.push(...(await dbMediaParts(snapshot.chatId, snapshot.messageId)));
        } else {
            for (const item of snapshot.mediaItems) {
                const part = await cachedMediaPart(item);
                if (part) mediaParts.push(part);
            }
        }
    }

    const mediaDescription = mediaParts.length
        ? mediaDescriptionOfParts(mediaParts)
        : mediaDescriptionOfItems(snapshot.mediaItems);
    const parts: UnifiedContentPart[] = [{
        type: 'text',
        text: buildReadyText(url, snapshot, mediaDescription, mediaParts.length > 0),
    }];
    parts.push(...mediaParts);
    return parts;
};

/** Database fallback for a link we never acquired (e.g. pasted before rollout) */
const renderFromDb = async (
    chatId: number,
    messageId: number,
    url: string,
    chatTitle: string | null,
    withMedia: boolean
): Promise<UnifiedContentPart[]> => {
    const target = await getContextMessage(chatId, messageId);
    if (!target) return [];

    const snapshot: ReadySnapshot = {
        chatId,
        messageId,
        chatTitle,
        senderName: target.userName,
        messageDate: target.date,
        text: truncateText(cleanStoredText(target.text), MAX_TARGET_TEXT_CHARS),
        replyToId: target.replyToId,
        contextItems: [],
        source: 'db',
        mediaItems: [],
    };

    if (target.replyToId !== null) {
        const reply = await getContextMessage(chatId, target.replyToId);
        if (reply) {
            snapshot.contextItems.push({
                role: 'reply-to',
                messageId: reply.messageId,
                senderName: reply.userName,
                date: reply.date.toISOString(),
                text: truncateText(cleanStoredText(reply.text), MAX_CONTEXT_TEXT_CHARS),
            });
        }
    }

    const mediaParts = withMedia ? await dbMediaParts(chatId, messageId) : [];
    const mediaDescription = mediaParts.length ? mediaDescriptionOfParts(mediaParts) : null;
    const parts: UnifiedContentPart[] = [{
        type: 'text',
        text: buildReadyText(url, snapshot, mediaDescription, mediaParts.length > 0),
    }];
    parts.push(...mediaParts);
    return parts;
};

const renderOne = async (
    chatId: number,
    entry: TgMessageLinkPlanEntry,
    contextNumbers: ReadonlyMap<number, number>,
    chatTitle: string | null
): Promise<UnifiedContentPart[]> => {
    const { url, link } = entry.parsed;

    // A same-chat link whose target is already numbered in this context: point
    // at the number instead of repeating the message and its media.
    if (link.chatRef.type === 'internal' && link.chatRef.chatId === chatId) {
        const contextNumber = contextNumbers.get(link.messageId);
        if (contextNumber !== undefined) {
            return [buildInContextNote(url, contextNumber)];
        }
    }

    const row = await loadCachedRow(url);
    if (row) return renderCachedRow(url, row, entry.withMedia);

    // Fallback: the bot already stored the target but no snapshot was acquired.
    if (link.chatRef.type === 'internal') {
        return renderFromDb(
            link.chatRef.chatId,
            link.messageId,
            url,
            link.chatRef.chatId === chatId ? chatTitle : null,
            entry.withMedia
        );
    }

    const resolved = peekResolvedChat(link.chatRef.username);
    if (resolved) {
        return renderFromDb(
            resolved.chatId,
            link.messageId,
            url,
            resolved.title,
            entry.withMedia
        );
    }

    return [];
};

/**
 * Build the context parts for one message's message links. Reads only caches
 * and our own database; never performs a network request.
 */
export const getTgMessageLinkPreviewParts = async (
    chatId: number,
    plan: TgMessageLinkPlan | undefined,
    contextNumbers: ReadonlyMap<number, number>,
    options: { chatTitle?: string | null } = {}
): Promise<UnifiedContentPart[]> => {
    if (!plan || plan.length === 0) return [];
    const parts: UnifiedContentPart[] = [];
    for (const entry of plan) {
        const rendered = await renderOne(
            chatId,
            entry,
            contextNumbers,
            options.chatTitle ?? null
        );
        parts.push(...rendered);
    }
    return parts;
};
