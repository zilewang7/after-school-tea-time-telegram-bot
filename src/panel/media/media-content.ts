/**
 * The media of one stored message / bot version, resolved for display: the
 * bytes inline in SQLite, a gs:// reference the route streams, or nothing once
 * the 7-day retention cleared the resource.
 *
 * The panel tree, the reply detail, the flat view and both share pages all go
 * through this module, so they agree on what "the media of this message" is and
 * on which MIME type it has.
 */
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { Op } from '@sequelize/core';
import { LinkPreviewCache, MediaCache, getMessage, type BotResponse, type ResponseVersion } from '../../db/index.js';
import { findBotResponseInChat, listSubImageMessages, type ContextMessage } from '../../db/queries/context-queries.js';
import { sniffMediaMime } from '../../ai/image-generation/image-mime.js';
import { getGcsObjectSize, openGcsReadStream } from '../../services/gcs-service.js';
import { extractFirstUrl } from '../../services/luoxu-preview-service.js';
import { base64ByteLength } from '../views/byte-size.js';
import type { PanelEnv } from '../context.js';

/** How the UI treats a media item; `sticker` is an animated (silent) sticker clip */
export type MediaKind = 'image' | 'video' | 'audio' | 'sticker' | 'file';

/** Everything a page needs to render one attachment; the URL is minted by the caller */
export interface MediaDescriptor {
    kind: MediaKind;
    mimeType: string;
    sizeBytes: number | null;
    /** Download name for documents, null for visual media */
    fileName: string | null;
}

/** A descriptor plus the bytes (inline) or the object (GCS) they live in */
export interface ResolvedMedia extends MediaDescriptor {
    inlineData: Buffer | null;
    gsUri: string | null;
}

/** Hint of a silent sticker clip; user messages carry it as their mediaHint */
const ANIMATED_STICKER_HINT = /animated sticker|\ban animation\b/i;

const kindOfMime = (mimeType: string): MediaKind => {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
};

/** An animated sticker arrives as a silent video clip; the UI loops it */
const kindOf = (mimeType: string, animatedSticker: boolean): MediaKind =>
    animatedSticker && mimeType.startsWith('video/') ? 'sticker' : kindOfMime(mimeType);

/** The document name out of `a file: name, mime` mediaHint */
const fileNameOfHint = (hint: string | null): string | null => {
    const matched = /^a file: (.+?), [^,]+$/.exec(hint ?? '');
    return matched === null ? null : (matched[1] ?? null);
};

const isWebm = (head: Buffer): boolean => head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;

const isMp4 = (head: Buffer): boolean => head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp';

const isWav = (head: Buffer): boolean =>
    head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';

const isOgg = (head: Buffer): boolean => head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS';

const isMp3 = (head: Buffer): boolean =>
    (head.length >= 3 && head.toString('ascii', 0, 3) === 'ID3')
    || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);

const isPdf = (head: Buffer): boolean => head.length >= 4 && head.toString('ascii', 0, 4) === '%PDF';

/**
 * MIME of bare bytes. Image formats come from the shared sniffer (the same one
 * the model side trusts); the container types only exist here, because this is
 * the only place that serves what Telegram stored verbatim.
 */
const mimeOfBytes = (head: Buffer): string | null => {
    const sniffed = sniffMediaMime(head);
    if (sniffed !== null) return sniffed;
    if (isWebm(head)) return 'video/webm';
    if (isMp4(head)) return 'video/mp4';
    if (isWav(head)) return 'audio/wav';
    if (isOgg(head)) return 'audio/ogg';
    if (isMp3(head)) return 'audio/mpeg';
    if (isPdf(head)) return 'application/pdf';
    return null;
};

/** Enough base64 for every signature; 96 chars decode to 72 bytes */
const MIME_HEAD_BASE64_CHARS = 96;

const descriptorOf = (mimeType: string, hint: string | null): MediaDescriptor => {
    const kind = kindOf(mimeType, ANIMATED_STICKER_HINT.test(hint ?? ''));
    return {
        kind,
        mimeType,
        sizeBytes: null,
        fileName: kind === 'file' ? fileNameOfHint(hint) : null,
    };
};

/** The media a stored bot version carries: its image / sticker, or its text file */
export const versionMediaDescriptorOf = (version: ResponseVersion): MediaDescriptor | null => {
    const imageBase64 = version.imageBase64;
    if (typeof imageBase64 === 'string' && imageBase64 !== '') {
        const head = Buffer.from(imageBase64.slice(0, MIME_HEAD_BASE64_CHARS), 'base64');
        const mimeType = mimeOfBytes(head) ?? (version.sticker === undefined ? 'image/png' : 'image/webp');
        return {
            kind: kindOf(mimeType, version.sticker !== undefined),
            mimeType,
            sizeBytes: base64ByteLength(imageBase64),
            fileName: null,
        };
    }
    const file = version.file;
    const fileBase64 = version.fileBase64;
    if (file !== undefined && typeof fileBase64 === 'string' && fileBase64 !== '') {
        return {
            kind: 'file',
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes > 0 ? file.sizeBytes : base64ByteLength(fileBase64),
            fileName: file.name,
        };
    }
    return null;
};

const chooseVersion = (response: BotResponse | null, versionId: number | null): ResponseVersion | null => {
    if (response === null) return null;
    if (versionId === null) return response.getCurrentVersion();
    return response.getVersions().find((version) => version.versionId === versionId) ?? null;
};

/** The media a bot version carries, with its bytes when inline */
export const resolveVersionMedia = async (
    chatId: number,
    firstMessageId: number,
    versionId: number | null
): Promise<ResolvedMedia | null> => {
    const response = await findBotResponseInChat(chatId, firstMessageId);
    const version = chooseVersion(response, versionId);
    if (version === null) return null;

    const imageBase64 = version.imageBase64;
    if (typeof imageBase64 === 'string' && imageBase64 !== '') {
        const inlineData = Buffer.from(imageBase64, 'base64');
        const descriptor = versionMediaDescriptorOf(version);
        if (descriptor === null) return null;
        return { ...descriptor, inlineData, gsUri: null };
    }
    const file = version.file;
    const fileBase64 = version.fileBase64;
    if (file !== undefined && typeof fileBase64 === 'string' && fileBase64 !== '') {
        const descriptor = versionMediaDescriptorOf(version);
        if (descriptor === null) return null;
        return { ...descriptor, inlineData: Buffer.from(fileBase64, 'base64'), gsUri: null };
    }
    return null;
};

/**
 * The media a message row carries. Bytes come from the content-addressed cache
 * (inline, or a gs:// object for >20 MB) and fall back to the legacy per-message
 * `file` BLOB. Null when the message has no media or the retention took it.
 */
export const resolveMessageMedia = async (chatId: number, messageId: number): Promise<ResolvedMedia | null> => {
    const message = await getMessage(chatId, messageId);
    if (message === null) return null;

    const fileUniqueId = message.fileUniqueId;
    if (fileUniqueId !== null) {
        const cached = await MediaCache.findByPk(fileUniqueId);
        if (cached !== null) {
            const descriptor = descriptorOf(cached.mime, message.mediaHint);
            const sizeBytes = cached.sizeBytes ?? cached.data?.length ?? null;
            if (cached.data !== null) {
                return { ...descriptor, sizeBytes, inlineData: cached.data, gsUri: null };
            }
            if (cached.fileUri !== null) {
                return {
                    ...descriptor,
                    sizeBytes: sizeBytes ?? (await getGcsObjectSize(cached.fileUri)),
                    inlineData: null,
                    gsUri: cached.fileUri,
                };
            }
        }
    }

    const legacyBytes = message.file;
    if (legacyBytes !== null && legacyBytes.length > 0) {
        const mimeType = message.fileMime ?? mimeOfBytes(legacyBytes.subarray(0, MIME_HEAD_BASE64_CHARS)) ?? 'application/octet-stream';
        return {
            ...descriptorOf(mimeType, message.mediaHint),
            sizeBytes: legacyBytes.length,
            inlineData: legacyBytes,
            gsUri: null,
        };
    }
    return null;
};

/** The fields of a stored message row that decide its media descriptor */
export type MessageMediaSource = Pick<
    ContextMessage,
    'messageId' | 'fileUniqueId' | 'file' | 'fileMime' | 'mediaHint'
>;

/**
 * Descriptors for many messages at once (the panel tree / a share page): one
 * metadata query, no bytes. Bot-written rows are the caller's business — the
 * bot's own media lives in its versions, not in these rows.
 */
export const loadMessageMediaDescriptors = async (
    messages: readonly MessageMediaSource[]
): Promise<Map<number, MediaDescriptor>> => {
    const descriptors = new Map<number, MediaDescriptor>();
    const uniqueIds = [...new Set(messages.map((message) => message.fileUniqueId).filter((id): id is string => id !== null))];
    const cachedRows = uniqueIds.length === 0
        ? []
        : await MediaCache.findAll({
            where: { fileUniqueId: { [Op.in]: uniqueIds } },
            attributes: ['fileUniqueId', 'mime', 'sizeBytes'],
        });
    const cachedByUniqueId = new Map(cachedRows.map((row) => [row.fileUniqueId, row]));

    for (const message of messages) {
        const cached = message.fileUniqueId === null ? undefined : cachedByUniqueId.get(message.fileUniqueId);
        if (cached !== undefined) {
            descriptors.set(message.messageId, {
                ...descriptorOf(cached.mime, message.mediaHint),
                sizeBytes: cached.sizeBytes ?? null,
            });
            continue;
        }
        const legacyBytes = message.file;
        if (legacyBytes !== null && legacyBytes.length > 0) {
            const mimeType = message.fileMime ?? 'application/octet-stream';
            descriptors.set(message.messageId, {
                ...descriptorOf(mimeType, message.mediaHint),
                sizeBytes: legacyBytes.length,
            });
        }
    }
    return descriptors;
};

/** One attachment of a bubble: which stored message owns the file, plus its descriptor */
export interface MessageMediaItem {
    messageId: number;
    descriptor: MediaDescriptor;
}

/**
 * Every attachment of each message's bubble, in display order: the message's
 * own media first, then the rest of its Telegram media group. Messages with no
 * attachment are absent from the map.
 *
 * A Telegram album stores its first item as an ordinary message and every
 * further item as a `sub image of [<first>]` reply (left out of the reply tree
 * on purpose, see listSubImageMessages); display surfaces show them all inside
 * the parent's bubble.
 */
export const loadMessageAlbumMedia = async (
    chatId: number,
    messages: readonly ContextMessage[]
): Promise<Map<number, MessageMediaItem[]>> => {
    const albumMedia = new Map<number, MessageMediaItem[]>();
    if (messages.length === 0) return albumMedia;

    const subImagesByParentId = await listSubImageMessages(
        chatId,
        messages.map((message) => message.messageId)
    );
    const descriptors = await loadMessageMediaDescriptors([
        ...messages,
        ...[...subImagesByParentId.values()].flat(),
    ]);

    for (const message of messages) {
        const items: MessageMediaItem[] = [];
        const own = descriptors.get(message.messageId);
        if (own !== undefined) items.push({ messageId: message.messageId, descriptor: own });
        // The children come back ascending by message id
        for (const subImage of subImagesByParentId.get(message.messageId) ?? []) {
            const descriptor = descriptors.get(subImage.messageId);
            if (descriptor !== undefined) items.push({ messageId: subImage.messageId, descriptor });
        }
        if (items.length > 0) albumMedia.set(message.messageId, items);
    }
    return albumMedia;
};

/** A link preview's attachment: the same facts plus the cache key its bytes live under */
export interface PreviewMediaDescriptor extends MediaDescriptor {
    mediaKey: string;
}

/** What a message needs for a preview lookup: its own text decides the URL */
export type PreviewSourceMessage = Pick<ContextMessage, 'messageId' | 'text' | 'fromBotSelf'>;

/** One serialized `link_preview_cache.mediaItems` entry (written by luoxu-preview-service) */
interface StoredPreviewMediaItem {
    which: string;
    kind: string;
    mime: string;
    mediaKey: string;
    sizeBytes: number;
}

const isStoredPreviewMediaItem = (value: unknown): value is StoredPreviewMediaItem => {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as Record<string, unknown>;
    return typeof item.mime === 'string' && typeof item.mediaKey === 'string' && item.mediaKey !== '';
};

const parsePreviewMediaItems = (raw: string | null): StoredPreviewMediaItem[] => {
    if (raw === null || raw === '') return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isStoredPreviewMediaItem) : [];
};

/** Telegram re-uploads the same picture into an Instant View: show each picture once */
const dedupePreviewItems = (items: readonly StoredPreviewMediaItem[]): StoredPreviewMediaItem[] => {
    const seen = new Set<string>();
    const kept: StoredPreviewMediaItem[] = [];
    for (const item of items) {
        const key = `${item.mime}:${item.sizeBytes ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(item);
    }
    return kept;
};

/** Most previews carry one picture; four is a hard cap so a page never floods */
const MAX_PREVIEW_MEDIA = 4;

/**
 * The captured link-preview attachments of the given messages: the picture (and
 * any document) Telegram crawled for the message's first URL. Metadata only —
 * the bytes stay in the cache until a page asks for them. Messages without a
 * URL, without a cached preview, or whose media the retention already cleared
 * are absent.
 */
export const loadLinkPreviewMediaDescriptors = async (
    messages: readonly PreviewSourceMessage[]
): Promise<Map<number, PreviewMediaDescriptor[]>> => {
    const descriptors = new Map<number, PreviewMediaDescriptor[]>();
    const urlByMessageId = new Map<number, string>();
    for (const message of messages) {
        if (message.fromBotSelf) continue;
        const url = extractFirstUrl(message.text);
        if (url !== null) urlByMessageId.set(message.messageId, url);
    }
    if (urlByMessageId.size === 0) return descriptors;

    const urls = [...new Set(urlByMessageId.values())];
    const rows = await LinkPreviewCache.findAll({
        where: { url: { [Op.in]: urls } },
        attributes: ['url', 'mediaItems'],
    });
    const itemsByUrl = new Map(rows.map((row) => [row.url, dedupePreviewItems(parsePreviewMediaItems(row.mediaItems)).slice(0, MAX_PREVIEW_MEDIA)]));

    const mediaKeys = [...new Set([...itemsByUrl.values()].flatMap((items) => items.map((item) => item.mediaKey)))];
    if (mediaKeys.length === 0) return descriptors;
    const cachedRows = await MediaCache.findAll({
        where: { fileUniqueId: { [Op.in]: mediaKeys } },
        attributes: ['fileUniqueId', 'mime', 'sizeBytes'],
    });
    const cachedByKey = new Map(cachedRows.map((row) => [row.fileUniqueId, row]));

    for (const [messageId, url] of urlByMessageId) {
        const items = itemsByUrl.get(url) ?? [];
        const previews: PreviewMediaDescriptor[] = [];
        for (const item of items) {
            const cached = cachedByKey.get(item.mediaKey);
            if (cached === undefined) continue;
            previews.push({
                ...descriptorOf(cached.mime, null),
                sizeBytes: cached.sizeBytes ?? item.sizeBytes ?? null,
                mediaKey: item.mediaKey,
            });
        }
        if (previews.length > 0) descriptors.set(messageId, previews);
    }
    return descriptors;
};

/** The bytes behind one preview media key, for the signed `/m/…` route */
export const resolveCachedMediaByKey = async (mediaKey: string): Promise<ResolvedMedia | null> => {
    const cached = await MediaCache.findByPk(mediaKey);
    if (cached === null) return null;
    const descriptor = descriptorOf(cached.mime, null);
    const sizeBytes = cached.sizeBytes ?? cached.data?.length ?? null;
    if (cached.data !== null) return { ...descriptor, sizeBytes, inlineData: cached.data, gsUri: null };
    if (cached.fileUri !== null) return { ...descriptor, sizeBytes, inlineData: null, gsUri: cached.fileUri };
    return null;
};

/** `bytes` for one possible HTTP range of a resource of known size */
type ParsedRange =
    | { status: 'none' }
    | { status: 'invalid' }
    | { status: 'partial'; range: { start: number; end: number } };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * One HTTP Range header against a size (inclusive ends). Only the single-range
 * form is honored; anything else streams the whole resource, which every client
 * accepts.
 */
const parseRangeHeader = (header: string | undefined, size: number | null): ParsedRange => {
    if (header === undefined || size === null) return { status: 'none' };
    const matched = RANGE_PATTERN.exec(header.trim());
    if (matched === null) return { status: 'none' };
    const rawStart = matched[1];
    const rawEnd = matched[2];
    const hasStart = rawStart !== '';
    const hasEnd = rawEnd !== '';
    if (!hasStart && !hasEnd) return { status: 'invalid' };
    const suffix = hasStart ? Number(rawStart) : Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix < 0) return { status: 'invalid' };
    if (!hasStart) {
        const length = Math.min(suffix, size);
        return { status: 'partial', range: { start: size - length, end: size - 1 } };
    }
    const start = suffix;
    const end = hasEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
    if (end < start) return { status: 'invalid' };
    return { status: 'partial', range: { start, end } };
};

const CACHE_CONTROL = 'private, max-age=600';

const contentDisposition = (kind: MediaKind, fileName: string | null): string =>
    kind === 'file' && fileName !== null
        ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
        : 'inline';

const baseHeaders = (media: ResolvedMedia, totalSize: number | null): Headers => {
    const headers = new Headers({
        'Content-Type': media.mimeType,
        'Cache-Control': CACHE_CONTROL,
        'X-Robots-Tag': 'noindex',
        'Content-Disposition': contentDisposition(media.kind, media.fileName),
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
    });
    if (totalSize !== null) headers.set('Content-Length', String(totalSize));
    return headers;
};

const rangeHeaders = (headers: Headers, start: number, end: number, total: number): Headers => {
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    return headers;
};

const webStreamOf = (stream: Readable): ReadableStream<Uint8Array> =>
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

/**
 * One media response: the stored bytes for the requested range, streamed from
 * GCS when the object is the only copy. Callers have already resolved access.
 */
export const serveMedia = async (context: Context<PanelEnv>, media: ResolvedMedia): Promise<Response> => {
    const totalSize = media.inlineData?.length ?? media.sizeBytes ?? null;
    const parsed = parseRangeHeader(context.req.header('range'), totalSize);

    if (parsed.status === 'invalid') {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize ?? 0}`, 'Cache-Control': 'no-store' },
        });
    }

    const headers = baseHeaders(media, totalSize);
    const range = parsed.status === 'partial' ? parsed.range : null;

    if (media.inlineData !== null) {
        const body = range === null ? media.inlineData : media.inlineData.subarray(range.start, range.end + 1);
        if (range !== null && totalSize !== null) rangeHeaders(headers, range.start, range.end, totalSize);
        return new Response(new Uint8Array(body), { status: range === null ? 200 : 206, headers });
    }

    if (media.gsUri !== null) {
        const stream = await openGcsReadStream(media.gsUri, range ?? undefined);
        if (stream === null) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        if (range !== null && totalSize !== null) rangeHeaders(headers, range.start, range.end, totalSize);
        return new Response(webStreamOf(stream), { status: range === null ? 200 : 206, headers });
    }

    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
};
