import { Bot } from "grammy";
import type { Api } from "grammy";
import { match } from "ts-pattern";
import { saveMessage, findBotResponseByMessageId, BotResponse, MediaCache, LinkPreviewCache, MessageLink, ButtonState } from "./index.js";
import { MessageAttachment } from './messageAttachmentDTO.js';
import { CustomEmojiAsset } from './customEmojiAssetDTO.js';
import { MessageRevision } from './messageRevisionDTO.js';
import { sequelize } from './config.js';
import { parseChatCommand, serializeChatCommand } from "../reply/commands/chat-command-parser.js";
import { withBusyRetry } from "./busy-retry.js";
import { Message } from "./messageDTO.js";
import { Op } from "@sequelize/core";
import {
    getMediaGroupIdTemp,
    setMediaGroupIdTemp,
    addAsyncFileSaveTask,
    removeAsyncFileSaveTask,
    retainAsyncFileSaveTasks,
    addAsyncPreviewTask,
    removeAsyncPreviewTask,
    retainAsyncPreviewTasks,
    addAsyncOcrTask,
    removeAsyncOcrTask,
    retainAsyncOcrTasks,
    markPendingEditWhileProcessing,
} from '../state.js';
import { buildResponseButtons } from '../cmd/menus/index.js';
import { getCachedMedia, putCachedMedia } from '../services/media-cache-service.js';
import { isGeminiSupportedMimeType } from '../ai/supported-mime.js';
import { uploadFileToGcs, uploadBytesToGcs, deleteGcsObject, isGcsEnabled } from '../services/gcs-service.js';
import { acquireLinkPreview, extractFirstUrl, isLuoxuPreviewEnabled } from '../services/luoxu-preview-service.js';
import { primeDanmakuSnapshot } from '../services/bilibili-danmaku-service.js';
import { acquireOcr, isLuoxuOcrEnabled } from '../services/luoxu-ocr-service.js';
import { convertTgsToWebm, normalizeShortVideo } from '../services/tgs-client.js';
import { to } from 'await-to-js';
import { readFile, unlink } from 'node:fs/promises';
import type { Message as TgMessage, MessageEntity, MessageOrigin, RichBlock, RichMessage, User } from 'grammy/types';
import { upsertTelegramUser } from './queries/user-queries.js';
import { entitiesToMarkdown, richBlocksToMarkdown } from 'telegram-md-entities';
import { extractCustomEmojiOccurrences } from '../services/custom-emoji-extractor.js';
import { acquireCustomEmojiAttachments } from '../services/custom-emoji-service.js';
import {
    failPendingCustomEmojiAttachments,
    replaceCustomEmojiAttachments,
} from './queries/message-attachment-queries.js';
import {
    claimMessageRevision,
    updateMessageMediaForRevision,
    type MessageRevisionToken,
} from './queries/message-revision-queries.js';
import { downloadTelegramFileBytes, resolveTelegramFile } from '../services/telegram-file-service.js';

// Parse sizes like "300M", "1G", "500K", "12345" (bare bytes); undefined on bad input
const parseByteSize = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const matched = /^(\d+)\s*([KMG]?)B?$/i.exec(raw.trim());
    if (!matched || !matched[1]) return undefined;
    const multipliers: Record<string, number> = { '': 1, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
    return Number(matched[1]) * (multipliers[(matched[2] ?? '').toUpperCase()] ?? 1);
};

/**
 * Normalize a small video buffer for Gemini: ultra-short clips (< ~1s) are
 * looped/padded by tgs-converter; normal-length videos pass through unchanged.
 * Returns a null-safe result so a converter outage never blocks media saving.
 */
const normalizeSmallVideo = async (
    data: Buffer,
    mime: string
): Promise<{ data: Buffer; mime: string }> => {
    if (!mime.startsWith('video/')) {
        return { data, mime };
    }
    const normalized = await normalizeShortVideo(data, mime);
    if (!normalized) {
        return { data, mime };
    }
    if (normalized.normalized) {
        console.log(`[autoSave] normalized short video ${data.length}B ${mime} -> ${normalized.data.length}B ${normalized.mimeType}`);
    }
    return { data: normalized.data, mime: normalized.mimeType };
};

// Hard cap on what we even attempt to fetch, overridable via MAX_MEDIA_BYTES in
// .env (e.g. "300M"). Defaults: cloud getFile tops out at 20MB; a self-hosted
// local Bot API server (TG_LOCAL_API_ROOT) raises it (local mode allows up to 2GB).
const MAX_MEDIA_BYTES = parseByteSize(process.env.MAX_MEDIA_BYTES)
    ?? (process.env.TG_LOCAL_API_ROOT ? 200 * 1024 * 1024 : 20 * 1024 * 1024);

// Above this, bytes go to GCS and Gemini gets a gs:// reference instead of inline
// base64 (keeps large files out of SQLite and the request body); at or below,
// media is inlined as a BLOB as before. Matches the cloud getFile boundary.
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

type MediaKind =
    | 'photo' | 'sticker' | 'video_sticker' | 'animated_sticker'
    | 'voice' | 'audio' | 'video' | 'video_note' | 'document';

interface CapturedMedia {
    /** Telegram file_id to download */
    fileId: string;
    /** Stable cache key across re-sends */
    fileUniqueId: string;
    /** Final MIME to persist (animated stickers become video/webm after conversion) */
    mime: string;
    kind: MediaKind;
    /** File size in bytes if Telegram reported it (used for the size cap) */
    sizeBytes?: number;
    /** Human-readable hint appended to message text for non-multimodal models */
    hint: string;
    /** Animated sticker (.tgs) needs rendering to webm via the converter service */
    needsTgsConversion: boolean;
}

/**
 * Resolve a capturable media file from a Telegram message.
 * Returns undefined when the message carries no supported media.
 */
const resolveCapturedMedia = (msg: TgMessage | undefined): CapturedMedia | undefined => {
    if (!msg) return undefined;

    const photo = msg.photo?.at(-1);
    if (photo) {
        const isGroup = Boolean(msg.media_group_id);
        return {
            fileId: photo.file_id,
            fileUniqueId: photo.file_unique_id,
            mime: 'image/jpeg',
            kind: 'photo',
            sizeBytes: photo.file_size,
            hint: isGroup ? 'some pictures' : 'a picture',
            needsTgsConversion: false,
        };
    }

    const sticker = msg.sticker;
    if (sticker) {
        // The pack emoji is loose metadata (Telegram often assigns one that has
        // nothing to do with the artwork), so it is surfaced as a labelled hint
        // only — never as the message text. What the emoji is worth is spelled
        // out for the model by the sticker nudges in the context builder.
        const emojiNote = sticker.emoji ? `, pack emoji: ${sticker.emoji}` : '';
        // Video sticker (.webm, VP9): download the real animation, Gemini can read it
        if (sticker.is_video) {
            return {
                fileId: sticker.file_id,
                fileUniqueId: sticker.file_unique_id,
                mime: 'video/webm',
                kind: 'video_sticker',
                sizeBytes: sticker.file_size,
                hint: `an animated sticker (a short video clip${emojiNote})`,
                needsTgsConversion: false,
            };
        }
        // Animated sticker (.tgs, Lottie vector): render to webm via converter service
        if (sticker.is_animated) {
            return {
                fileId: sticker.file_id,
                fileUniqueId: sticker.file_unique_id,
                mime: 'video/webm', // after conversion
                kind: 'animated_sticker',
                sizeBytes: sticker.file_size,
                hint: `an animated sticker (a short video clip${emojiNote})`,
                needsTgsConversion: true,
            };
        }
        return {
            fileId: sticker.file_id,
            fileUniqueId: sticker.file_unique_id,
            mime: 'image/webp',
            kind: 'sticker',
            sizeBytes: sticker.file_size,
            hint: sticker.emoji ? `a sticker image (pack emoji: ${sticker.emoji})` : 'a sticker image',
            needsTgsConversion: false,
        };
    }

    const voice = msg.voice;
    if (voice) {
        return {
            fileId: voice.file_id,
            fileUniqueId: voice.file_unique_id,
            mime: voice.mime_type ?? 'audio/ogg',
            kind: 'voice',
            sizeBytes: voice.file_size,
            hint: `a voice message${voice.duration ? `, ${voice.duration}s` : ''}`,
            needsTgsConversion: false,
        };
    }

    const audio = msg.audio;
    if (audio) {
        return {
            fileId: audio.file_id,
            fileUniqueId: audio.file_unique_id,
            mime: audio.mime_type ?? 'audio/mpeg',
            kind: 'audio',
            sizeBytes: audio.file_size,
            hint: `an audio file${audio.file_name ? `: ${audio.file_name}` : ''}`,
            needsTgsConversion: false,
        };
    }

    const video = msg.video;
    if (video) {
        return {
            fileId: video.file_id,
            fileUniqueId: video.file_unique_id,
            mime: video.mime_type ?? 'video/mp4',
            kind: 'video',
            sizeBytes: video.file_size,
            hint: 'a video',
            needsTgsConversion: false,
        };
    }

    const videoNote = msg.video_note;
    if (videoNote) {
        return {
            fileId: videoNote.file_id,
            fileUniqueId: videoNote.file_unique_id,
            mime: 'video/mp4',
            kind: 'video_note',
            sizeBytes: videoNote.file_size,
            hint: 'a video note',
            needsTgsConversion: false,
        };
    }

    const document = msg.document;
    if (document) {
        const mime = document.mime_type ?? 'application/octet-stream';
        return {
            fileId: document.file_id,
            fileUniqueId: document.file_unique_id,
            mime,
            kind: 'document',
            sizeBytes: document.file_size,
            hint: mime.startsWith('image/')
                ? 'a picture'
                : `a file: ${document.file_name ?? 'unknown'}, ${mime}`,
            needsTgsConversion: false,
        };
    }

    return undefined;
};

/**
 * Collect downloadable media carried inside rich message blocks. Media blocks
 * hold ordinary file_ids (RichBlockPhoto.photo is a plain PhotoSize[]), so the
 * normal getFile pipeline applies. Container blocks nest, hence the recursion.
 */
const collectRichBlockMedia = (blocks: RichBlock[], found: CapturedMedia[]): void => {
    for (const block of blocks) {
        switch (block.type) {
            case 'photo': {
                const size = block.photo.at(-1);
                if (size) {
                    found.push({
                        fileId: size.file_id,
                        fileUniqueId: size.file_unique_id,
                        mime: 'image/jpeg',
                        kind: 'photo',
                        sizeBytes: size.file_size,
                        hint: 'a picture',
                        needsTgsConversion: false,
                    });
                }
                break;
            }
            case 'video':
                found.push({
                    fileId: block.video.file_id,
                    fileUniqueId: block.video.file_unique_id,
                    mime: block.video.mime_type ?? 'video/mp4',
                    kind: 'video',
                    sizeBytes: block.video.file_size,
                    hint: 'a video',
                    needsTgsConversion: false,
                });
                break;
            case 'animation':
                found.push({
                    fileId: block.animation.file_id,
                    fileUniqueId: block.animation.file_unique_id,
                    mime: block.animation.mime_type ?? 'video/mp4',
                    kind: 'video',
                    sizeBytes: block.animation.file_size,
                    hint: 'an animation',
                    needsTgsConversion: false,
                });
                break;
            case 'audio':
                found.push({
                    fileId: block.audio.file_id,
                    fileUniqueId: block.audio.file_unique_id,
                    mime: block.audio.mime_type ?? 'audio/mpeg',
                    kind: 'audio',
                    sizeBytes: block.audio.file_size,
                    hint: `an audio file${block.audio.file_name ? `: ${block.audio.file_name}` : ''}`,
                    needsTgsConversion: false,
                });
                break;
            case 'voice_note':
                found.push({
                    fileId: block.voice_note.file_id,
                    fileUniqueId: block.voice_note.file_unique_id,
                    mime: block.voice_note.mime_type ?? 'audio/ogg',
                    kind: 'voice',
                    sizeBytes: block.voice_note.file_size,
                    hint: `a voice message${block.voice_note.duration ? `, ${block.voice_note.duration}s` : ''}`,
                    needsTgsConversion: false,
                });
                break;
            case 'blockquote':
            case 'details':
            case 'collage':
            case 'slideshow':
                collectRichBlockMedia(block.blocks, found);
                break;
            case 'list':
                for (const item of block.items) {
                    collectRichBlockMedia(item.blocks, found);
                }
                break;
            default:
                break;
        }
    }
};

/**
 * Pick the media file to attach for a rich message. The messages table has a
 * single file slot per row, so only one media is downloaded: the first photo
 * block, or the first media block of any kind when there is no photo. The hint
 * discloses how many media the message actually carries.
 */
const resolveRichMessageMedia = (richMessage: RichMessage | undefined): CapturedMedia | undefined => {
    if (!richMessage) return undefined;
    const found: CapturedMedia[] = [];
    collectRichBlockMedia(richMessage.blocks, found);
    const picked = found.find((m) => m.kind === 'photo') ?? found[0];
    if (!picked) return undefined;
    if (found.length > 1) {
        return {
            ...picked,
            hint: `${picked.hint} (this rich message carries ${found.length} media files, only this one is attached)`,
        };
    }
    return picked;
};

/**
 * Feed every User object a message exposes into the roster: the author, a
 * forwarded-from user, and text_mention entities (users without a @username
 * being pointed at). Fire-and-forget — roster completeness never blocks or
 * fails an ingest.
 */
const harvestRosterUsers = (msg: TgMessage | undefined): void => {
    if (!msg) return;
    const users: User[] = [];
    if (msg.from) users.push(msg.from);
    if (msg.forward_origin?.type === 'user') users.push(msg.forward_origin.sender_user);
    for (const entity of [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]) {
        if (entity.type === 'text_mention') users.push(entity.user);
    }
    for (const user of users) {
        void upsertTelegramUser({
            userId: user.id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            isBot: user.is_bot,
        });
    }
};

/** Forward origin as stored in the forwardOrigin column, e.g. "user 张三" */
const resolveForwardOrigin = (origin: MessageOrigin | undefined): string | undefined => {
    if (!origin) return undefined;
    return match(origin)
        .with({ type: 'user' }, (o) =>
            `user ${o.sender_user.first_name}${o.sender_user.last_name ? ` ${o.sender_user.last_name}` : ''}`)
        .with({ type: 'hidden_user' }, (o) => `user ${o.sender_user_name}`)
        .with({ type: 'chat' }, (o) =>
            `chat ${'title' in o.sender_chat ? o.sender_chat.title : o.sender_chat.first_name}`)
        .with({ type: 'channel' }, (o) => `channel ${o.chat.title}`)
        .exhaustive();
};

/**
 * Store user messages as markdown: formatting entities (bold/italic/spoiler/
 * code/links/quotes/...) survive into the DB and the LLM context instead of
 * being flattened to plain text. Server auto-detections (bare urls, hashtags,
 * mentions) pass through as plain text unchanged.
 */
const renderTextWithEntities = (
    text: string | undefined,
    entities: MessageEntity[] | undefined
): string | undefined => {
    if (!text) return text;
    if (!entities?.length) return text;
    return entitiesToMarkdown({ text, entities });
};

/** Rich messages (Premium rich text editor, Bot API 10.1+) → markdown */
const renderRichMessage = (richMessage: RichMessage | undefined): string | undefined => {
    if (!richMessage) return undefined;
    const markdown = richBlocksToMarkdown(richMessage.blocks).trim();
    return markdown.length > 0 ? markdown : undefined;
};

const CUSTOM_EMOJI_ENABLED = process.env.CUSTOM_EMOJI_ENABLED !== '0';
let asyncTaskNonce = 0;

const createRevisionTaskId = (
    kind: string,
    revision: MessageRevisionToken
): string => {
    asyncTaskNonce += 1;
    return `${kind}:${asyncTaskNonce}:${revision.telegramTimestamp}:${revision.updateId}`;
};

const CUSTOM_EMOJI_ACQUISITION_TIMEOUT_MS = 60000;

const startCustomEmojiAcquisition = (
    bot: Bot,
    revision: MessageRevisionToken,
    taskId: string
): void => {
    const controller = new AbortController();
    let settled = false;
    const settleTask = (): void => {
        if (settled) return;
        settled = true;
        removeAsyncFileSaveTask(revision.chatId, revision.messageId, taskId);
    };
    const backstop = setTimeout(() => {
        controller.abort(new Error('custom emoji acquisition timed out'));
        void withBusyRetry(
            () => failPendingCustomEmojiAttachments(
                revision,
                'custom emoji acquisition timed out; visual omitted'
            ),
            `custom emoji timeout ${revision.chatId}/${revision.messageId}`
        ).catch((error: unknown) => {
            console.error('[custom-emoji] timeout finalization failed:', error);
        }).finally(settleTask);
    }, CUSTOM_EMOJI_ACQUISITION_TIMEOUT_MS);

    void acquireCustomEmojiAttachments(bot, revision, controller.signal)
        .catch((error: unknown) => {
            console.error(
                `[custom-emoji] acquisition failed for ${revision.chatId}/${revision.messageId}:`,
                error
            );
        })
        .finally(() => {
            clearTimeout(backstop);
            settleTask();
        });
};

/** Outcome of trying to acquire media bytes into the cache */
type AcquireResult =
    | { status: 'cached'; fileUniqueId: string; mime: string }
    | { status: 'too_large' }
    | { status: 'unsupported' }
    | { status: 'download_failed' }
    | { status: 'convert_failed' };

const mediaHintForAcquireResult = (
    media: CapturedMedia,
    outcome: AcquireResult
): string =>
    match(outcome)
        .with({ status: 'cached' }, () => media.hint)
        .with({ status: 'too_large' }, () => `${media.hint} — too large to process, you cannot see it`)
        .with({ status: 'unsupported' }, () => `${media.hint} — file type not supported, you cannot see it`)
        .with({ status: 'download_failed' }, () => `${media.hint} — failed to download, you cannot see it`)
        .with({ status: 'convert_failed' }, () => `${media.hint} — failed to render, you cannot see it`)
        .exhaustive();

/**
 * Ensure a media file's bytes are available in MediaCache, downloading and
 * (for animated stickers) converting as needed. Never throws — returns a
 * status the caller uses to pick the right text hint.
 */
const acquireMediaBytes = async (
    bot: Bot,
    media: CapturedMedia
): Promise<AcquireResult> => {
    // Gemini can't ingest this type (e.g. a .zip / arbitrary binary). Don't waste
    // a download/upload on bytes the model would only reject — the text hint alone
    // tells the model a file was shared. (media.mime is the final stored MIME;
    // animated stickers are already video/webm here, so they pass.)
    if (!isGeminiSupportedMimeType(media.mime)) {
        return { status: 'unsupported' };
    }

    // Cache hit: nothing to download/convert
    const cached = await getCachedMedia(media.fileUniqueId);
    if (cached) {
        return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: cached.mime };
    }

    // Oversized: beyond what we'll even fetch
    if (media.sizeBytes !== undefined && media.sizeBytes > MAX_MEDIA_BYTES) {
        return { status: 'too_large' };
    }

    // Animated stickers (.tgs) need the raw bytes to render to webm (the result
    // is small), so always materialize bytes and inline the converted clip.
    if (media.needsTgsConversion) {
        const [bytesErr, rawBytes] = await to(downloadTelegramFileBytes(bot, media.fileId));
        if (bytesErr || !rawBytes) {
            console.error(`[autoSave] download failed for ${media.kind}:`, bytesErr?.message || 'no bytes');
            return { status: 'download_failed' };
        }
        const converted = await convertTgsToWebm(rawBytes);
        if (!converted) {
            return { status: 'convert_failed' };
        }
        const normalizedVideo = await normalizeSmallVideo(converted.data, converted.mime);
        await putCachedMedia({ fileUniqueId: media.fileUniqueId, data: normalizedVideo.data, sizeBytes: normalizedVideo.data.length, mime: normalizedVideo.mime, kind: media.kind });
        return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: normalizedVideo.mime };
    }

    // Resolve the file: local Bot API yields an on-disk path (so large files can
    // be streamed to GCS without loading them into memory); cloud yields bytes.
    const [resolveErr, resolved] = await to(resolveTelegramFile(bot, media.fileId));
    if (resolveErr || !resolved) {
        console.error(`[autoSave] resolve failed for ${media.kind}:`, resolveErr?.message || 'no file');
        return { status: 'download_failed' };
    }

    const size = resolved.kind === 'path' ? resolved.size : resolved.bytes.length;

    // Large file → GCS (gs:// reference), kept out of SQLite. Without GCS
    // configured we don't take it (inlining would bloat SQLite / blow limits).
    if (size > INLINE_MAX_BYTES) {
        if (!isGcsEnabled()) {
            return { status: 'too_large' };
        }
        const [uploadErr, fileUri] = await to(
            resolved.kind === 'path'
                ? uploadFileToGcs(resolved.path, media.fileUniqueId, media.mime)
                : uploadBytesToGcs(resolved.bytes, media.fileUniqueId, media.mime)
        );
        if (resolved.kind === 'path') {
            await to(unlink(resolved.path)); // drop the local copy regardless
        }
        if (uploadErr || !fileUri) {
            console.error('[autoSave] GCS upload failed:', uploadErr?.message);
            return { status: 'download_failed' };
        }
        await putCachedMedia({ fileUniqueId: media.fileUniqueId, fileUri, sizeBytes: size, mime: media.mime, kind: media.kind });
        return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: media.mime };
    }

    // Small file → inline BLOB (existing behavior), normalizing ultra-short
    // videos so Gemini accepts them instead of 400-ing the whole request.
    const inlineBytes = resolved.kind === 'path' ? await readFile(resolved.path) : resolved.bytes;
    if (resolved.kind === 'path') {
        await to(unlink(resolved.path));
    }
    const normalizedVideo = await normalizeSmallVideo(inlineBytes, media.mime);
    await putCachedMedia({ fileUniqueId: media.fileUniqueId, data: normalizedVideo.data, sizeBytes: normalizedVideo.data.length, mime: normalizedVideo.mime, kind: media.kind });
    return { status: 'cached', fileUniqueId: media.fileUniqueId, mime: normalizedVideo.mime };
};

// 监听编辑消息并更新数据库
export const autoUpdate = (bot: Bot) => {
    bot.on('edited_message', async (ctx) => {
        const editedMsg = ctx.editedMessage;
        if (!editedMsg || !ctx.chat?.id) return;

        const chatId = ctx.chat.id;
        const messageId = editedMsg.message_id;

        try {
            const newText = renderTextWithEntities(editedMsg.text, editedMsg.entities)
                || renderTextWithEntities(editedMsg.caption, editedMsg.caption_entities)
                || renderRichMessage(editedMsg.rich_message)
                || '';
            const resolvedEditedMedia = resolveCapturedMedia(editedMsg)
                ?? resolveRichMessageMedia(editedMsg.rich_message);
            const newQuoteText = renderTextWithEntities(
                editedMsg.quote?.text,
                editedMsg.quote?.entities
            );
            const revisionToken: MessageRevisionToken = {
                chatId,
                messageId,
                updateId: ctx.update.update_id,
                telegramTimestamp: editedMsg.edit_date ?? editedMsg.date,
            };
            const customEmojiOccurrences = CUSTOM_EMOJI_ENABLED
                ? extractCustomEmojiOccurrences(editedMsg)
                : [];
            const previewUrl = isLuoxuPreviewEnabled() ? extractFirstUrl(newText) : null;
            const shouldAcquireOcr = isLuoxuOcrEnabled()
                && Boolean(resolvedEditedMedia || previewUrl);
            const mediaTaskId = createRevisionTaskId('primary-media-edit', revisionToken);
            const emojiTaskId = createRevisionTaskId('custom-emoji', revisionToken);
            const previewTaskId = createRevisionTaskId('link-preview', revisionToken);
            const ocrTaskId = createRevisionTaskId('ocr', revisionToken);

            if (resolvedEditedMedia) addAsyncFileSaveTask(chatId, messageId, mediaTaskId);
            if (customEmojiOccurrences.length > 0) {
                addAsyncFileSaveTask(chatId, messageId, emojiTaskId);
            }
            if (previewUrl) addAsyncPreviewTask(chatId, messageId, previewTaskId);
            if (shouldAcquireOcr) addAsyncOcrTask(chatId, messageId, ocrTaskId);
            let editedMediaForAcquisition: CapturedMedia | undefined;

            try {
                const editResult = await withBusyRetry(
                    () => sequelize.transaction(async (transaction) => {
                        if (!(await claimMessageRevision(revisionToken, transaction))) {
                            return { accepted: false, editedMedia: undefined };
                        }
                        let currentMessage = await Message.findOne({
                            where: { chatId, messageId },
                            transaction,
                        });
                        if (!currentMessage) {
                            currentMessage = await Message.create({
                                chatId,
                                messageId,
                                fromBotSelf: editedMsg.from?.id === Number(process.env.BOT_USER_ID),
                                userId: editedMsg.from?.id ?? null,
                                date: new Date(editedMsg.date * 1000),
                                userName: editedMsg.from?.first_name ?? '佚名',
                                text: newText,
                                quoteText: newQuoteText ?? null,
                                file: null,
                                fileMime: null,
                                fileUniqueId: null,
                                replyToId: editedMsg.reply_to_message?.message_id ?? null,
                                chatCommand: null,
                                modelParts: null,
                                mediaHint: resolvedEditedMedia?.hint ?? null,
                                forwardOrigin: resolveForwardOrigin(editedMsg.forward_origin) ?? null,
                                forwardFromId: editedMsg.forward_origin?.type === 'user'
                                    ? editedMsg.forward_origin.sender_user.id
                                    : null,
                                viaBot: editedMsg.via_bot?.username
                                    ? `@${editedMsg.via_bot.username}`
                                    : editedMsg.via_bot?.first_name ?? null,
                                ocrText: null,
                            }, { transaction });
                        }
                        const editedMedia = resolvedEditedMedia
                            && currentMessage.fileUniqueId !== resolvedEditedMedia.fileUniqueId
                            ? resolvedEditedMedia
                            : undefined;
                        currentMessage.text = newText;
                        currentMessage.quoteText = newQuoteText ?? currentMessage.quoteText;
                        if (shouldAcquireOcr) currentMessage.ocrText = null;
                        if (editedMedia) {
                            currentMessage.file = null;
                            currentMessage.fileMime = null;
                            currentMessage.fileUniqueId = null;
                            currentMessage.ocrText = null;
                            currentMessage.mediaHint = editedMedia.hint;
                        }
                        await currentMessage.save({ transaction });
                        await replaceCustomEmojiAttachments(
                            revisionToken,
                            customEmojiOccurrences,
                            transaction
                        );
                        return { accepted: true, editedMedia };
                    }),
                    `edit ${chatId}/${messageId}`
                );
                if (!editResult.accepted) {
                    removeAsyncFileSaveTask(chatId, messageId, mediaTaskId);
                    removeAsyncFileSaveTask(chatId, messageId, emojiTaskId);
                    removeAsyncPreviewTask(chatId, messageId, previewTaskId);
                    removeAsyncOcrTask(chatId, messageId, ocrTaskId);
                    return;
                }
                retainAsyncFileSaveTasks(
                    chatId,
                    messageId,
                    revisionToken,
                    [
                        ...(editResult.editedMedia ? [mediaTaskId] : []),
                        ...(customEmojiOccurrences.length > 0 ? [emojiTaskId] : []),
                    ]
                );
                retainAsyncPreviewTasks(
                    chatId,
                    messageId,
                    revisionToken,
                    previewUrl ? [previewTaskId] : []
                );
                retainAsyncOcrTasks(
                    chatId,
                    messageId,
                    revisionToken,
                    shouldAcquireOcr ? [ocrTaskId] : []
                );
                if (!editResult.editedMedia) {
                    removeAsyncFileSaveTask(chatId, messageId, mediaTaskId);
                }
                editedMediaForAcquisition = editResult.editedMedia;
            } catch (error) {
                removeAsyncFileSaveTask(chatId, messageId, mediaTaskId);
                removeAsyncFileSaveTask(chatId, messageId, emojiTaskId);
                removeAsyncPreviewTask(chatId, messageId, previewTaskId);
                removeAsyncOcrTask(chatId, messageId, ocrTaskId);
                throw error;
            }

            if (customEmojiOccurrences.length > 0) {
                startCustomEmojiAcquisition(bot, revisionToken, emojiTaskId);
            }

            if (editedMediaForAcquisition) {
                const fileBackstop = setTimeout(
                    () => removeAsyncFileSaveTask(chatId, messageId, mediaTaskId),
                    70000
                );
                void (async () => {
                    const [acquireErr, result] = await to(
                        acquireMediaBytes(bot, editedMediaForAcquisition)
                    );
                    const outcome: AcquireResult = acquireErr || !result
                        ? { status: 'download_failed' }
                        : result;
                    const finalHint = mediaHintForAcquireResult(editedMediaForAcquisition, outcome);
                    const [saveErr] = await to(withBusyRetry(
                        () => updateMessageMediaForRevision(
                            revisionToken,
                            outcome.status === 'cached'
                                ? {
                                    fileMime: outcome.mime,
                                    fileUniqueId: outcome.fileUniqueId,
                                    mediaHint: finalHint,
                                }
                                : { mediaHint: finalHint }
                        ),
                        `edited media update ${chatId}/${messageId}`
                    ));
                    if (saveErr) {
                        console.error('[autoUpdate] Failed to update edited media:', saveErr);
                    }
                    clearTimeout(fileBackstop);
                    removeAsyncFileSaveTask(chatId, messageId, mediaTaskId);
                })();
            }

            console.log(`[autoUpdate] Updated message ${messageId} in chat ${chatId}`);

            let previewAcquisition: Promise<unknown> | undefined;
            if (previewUrl) {
                const previewBackstop = setTimeout(
                    () => removeAsyncPreviewTask(chatId, messageId, previewTaskId),
                    70000
                );
                previewAcquisition = (async () => {
                    const [previewErr] = await to(acquireLinkPreview(chatId, messageId, previewUrl));
                    if (previewErr) {
                        console.error('[autoUpdate] link preview acquire failed:', previewErr.message);
                    }
                    clearTimeout(previewBackstop);
                    removeAsyncPreviewTask(chatId, messageId, previewTaskId);
                })();
            }

            if (shouldAcquireOcr) {
                const ocrBackstop = setTimeout(
                    () => removeAsyncOcrTask(chatId, messageId, ocrTaskId),
                    70000
                );
                void (async () => {
                    if (previewAcquisition) await to(previewAcquisition);
                    const [ocrErr] = await to(acquireOcr(revisionToken, previewUrl));
                    if (ocrErr) {
                        console.error('[autoUpdate] ocr acquire failed:', ocrErr.message);
                    }
                    clearTimeout(ocrBackstop);
                    removeAsyncOcrTask(chatId, messageId, ocrTaskId);
                })();
            }

            const ownResponse = await BotResponse.findOne({
                where: { chatId, userMessageId: messageId },
            });
            if (ownResponse) {
                if (ownResponse.buttonState === ButtonState.PROCESSING) {
                    markPendingEditWhileProcessing(chatId, messageId);
                } else if (
                    ownResponse.buttonState === ButtonState.NONE
                    || ownResponse.buttonState === ButtonState.EDIT_DETECTED
                ) {
                    await addEditDetectedButton(ctx.api, chatId, ownResponse);
                }
            }
        } catch (error) {
            console.error("[autoUpdate] 更新消息失败", error);
        }
    });
};

const addEditDetectedButton = async (api: Api, chatId: number, response: BotResponse): Promise<void> => {
    const currentVersion = response.getCurrentVersion();
    if (!currentVersion) return;

    // Update button state
    response.buttonState = ButtonState.EDIT_DETECTED;
    await response.save();

    // Add retry button to the bot message
    const lastMessageId = currentVersion.messageIds.at(-1) || currentVersion.currentMessageId;
    const buttons = buildResponseButtons(ButtonState.EDIT_DETECTED);

    const [err] = await to(
        api.editMessageReplyMarkup(chatId, lastMessageId, {
            reply_markup: buttons,
        })
    );

    if (err && !err.message.includes('message is not modified')) {
        console.error(`[editMonitor] Failed to add retry button to message ${lastMessageId}:`, err);
    } else {
        console.log(`[editMonitor] Added edit-detected retry button to message ${lastMessageId}`);
    }
};

// 自动保存消息到数据库
export const autoSave = (bot: Bot) => {
    // 使用中间件
    bot.use(async (ctx, next) => {
        const excludeList = ['/context'];

        excludeList.forEach((item) => {
            excludeList.push(item + `@${process.env.BOT_USER_NAME}`);
        })

        if (ctx.chat?.id && ctx.message?.message_id && ctx.from?.id && !excludeList.includes(ctx.message.text || '')) {
            let replyToId = ctx.message.reply_to_message?.message_id;
            let isSubImage = false;
            let registeredPrimaryTask: { chatId: number; messageId: number; taskId: string } | undefined;
            let registeredEmojiTask: { chatId: number; messageId: number; taskId: string } | undefined;
            let registeredPreviewTask: { chatId: number; messageId: number; taskId: string } | undefined;
            let registeredOcrTask: { chatId: number; messageId: number; taskId: string } | undefined;

            // If replying to a bot message, resolve to firstMessageId
            // This ensures context building works correctly even after version switching
            if (replyToId) {
                const botResponse = await findBotResponseByMessageId(ctx.chat.id, replyToId);
                if (botResponse) {
                    replyToId = botResponse.messageId; // Use firstMessageId
                }
            }

            try {
                if (ctx.update.message?.media_group_id) {
                    const mediaGroupTemp = getMediaGroupIdTemp();
                    if (mediaGroupTemp.chatId === ctx.chat.id && mediaGroupTemp.mediaGroupId === ctx.message.media_group_id) {
                        replyToId = mediaGroupTemp.messageId;
                        isSubImage = true;
                    } else {
                        setMediaGroupIdTemp({
                            chatId: ctx.chat.id,
                            messageId: ctx.message.message_id,
                            mediaGroupId: ctx.update.message.media_group_id
                        });
                    }
                }

                const media = resolveCapturedMedia(ctx.update.message)
                    ?? resolveRichMessageMedia(ctx.update.message?.rich_message);

                // Restore URLs hidden in text_link entities before storing, so the
                // saved text carries the full original information (and link-preview
                // extraction sees the same string at save and build time).
                const messageText = renderTextWithEntities(ctx.message?.text, ctx.message?.entities);
                const messageCaption = renderTextWithEntities(ctx.message?.caption, ctx.message?.caption_entities);

                // A /chat command's own syntax is not content: only what the user
                // wrote after the parameters is stored as the message text, and the
                // parsed parameters go into the chatCommand column — that column is
                // what marks the message as a /chat summon at context-build time,
                // including for `/chat 1`, which attaches nothing at all.
                const chatCommand = parseChatCommand(messageText || messageCaption);
                const chatCommandSpec =
                    !isSubImage && chatCommand.type === 'valid' ? chatCommand.spec : null;

                // Build the base text + an optimistic media hint. This is saved
                // immediately so the message always lands in context, even if the
                // media download/conversion later fails (fixes the big-file bug).
                const baseText = isSubImage ? `sub image of [${replyToId}]` :
                    (
                        (chatCommandSpec
                            ? chatCommandSpec.prompt ?? ''
                            // A sticker-only message has no text: its pack emoji lives
                            // in the media hint, so the model reads the artwork instead
                            // of treating the emoji as something the user typed.
                            : messageText || messageCaption
                                || renderRichMessage(ctx.message?.rich_message)
                                || ''
                        )
                    );
                harvestRosterUsers(ctx.message);
                const forwardOrigin = resolveForwardOrigin(ctx.message?.forward_origin);
                // Original sender's id (privacy-protected forwards have none);
                // lets the context roster resolve who the forward came from
                const forwardFromId = ctx.message?.forward_origin?.type === 'user'
                    ? ctx.message.forward_origin.sender_user.id
                    : undefined;
                // Inline-mode messages ("via @bot"): the content came out of that
                // bot's inline results, not typed by the user
                const viaBot = ctx.message?.via_bot
                    ? (ctx.message.via_bot.username
                        ? `@${ctx.message.via_bot.username}`
                        : ctx.message.via_bot.first_name)
                    : undefined;

                const chatId = ctx.chat.id;
                const messageId = ctx.message.message_id;
                const userId = ctx.from.id;
                const date = new Date(ctx.message?.date * 1000);
                const userName = ctx.from.first_name;
                const quoteText = renderTextWithEntities(
                    ctx.message?.quote?.text,
                    ctx.message?.quote?.entities
                );
                const revisionToken: MessageRevisionToken = {
                    chatId,
                    messageId,
                    updateId: ctx.update.update_id,
                    telegramTimestamp: ctx.message.date,
                };
                const customEmojiOccurrences = CUSTOM_EMOJI_ENABLED && !isSubImage
                    ? extractCustomEmojiOccurrences(ctx.message)
                    : [];
                const previewUrl = isLuoxuPreviewEnabled() ? extractFirstUrl(baseText) : null;
                const shouldAcquireOcr = isLuoxuOcrEnabled() && Boolean(media || previewUrl);

                // Register every batch before the first await, so a rapid reply
                // waits for both the original media and all custom emoji assets.
                if (media) {
                    registeredPrimaryTask = {
                        chatId,
                        messageId,
                        taskId: createRevisionTaskId('primary-media', revisionToken),
                    };
                    addAsyncFileSaveTask(chatId, messageId, registeredPrimaryTask.taskId);
                }
                if (customEmojiOccurrences.length > 0) {
                    registeredEmojiTask = {
                        chatId,
                        messageId,
                        taskId: createRevisionTaskId('custom-emoji', revisionToken),
                    };
                    addAsyncFileSaveTask(chatId, messageId, registeredEmojiTask.taskId);
                }
                if (previewUrl) {
                    registeredPreviewTask = {
                        chatId,
                        messageId,
                        taskId: createRevisionTaskId('link-preview', revisionToken),
                    };
                    addAsyncPreviewTask(chatId, messageId, registeredPreviewTask.taskId);
                }
                if (shouldAcquireOcr) {
                    registeredOcrTask = {
                        chatId,
                        messageId,
                        taskId: createRevisionTaskId('ocr', revisionToken),
                    };
                    addAsyncOcrTask(chatId, messageId, registeredOcrTask.taskId);
                }

                // Text and its emoji manifest become visible atomically. Media
                // acquisition happens afterwards and can fail independently.
                const revisionAccepted = await withBusyRetry(
                    () => sequelize.transaction(async (transaction) => {
                        if (!(await claimMessageRevision(revisionToken, transaction))) return false;
                        await saveMessage({
                            chatId,
                            messageId,
                            userId,
                            date,
                            userName,
                            message: baseText,
                            quoteText,
                            replyToId,
                            chatCommand: chatCommandSpec ? serializeChatCommand(chatCommandSpec) : null,
                            mediaHint: media ? media.hint : undefined,
                            forwardOrigin,
                            forwardFromId,
                            viaBot,
                            transaction,
                        });
                        await replaceCustomEmojiAttachments(
                            revisionToken,
                            customEmojiOccurrences,
                            transaction
                        );
                        return true;
                    }),
                    `ingest ${chatId}/${messageId}`
                );
                if (!revisionAccepted) {
                    if (registeredPrimaryTask) {
                        removeAsyncFileSaveTask(chatId, messageId, registeredPrimaryTask.taskId);
                    }
                    if (registeredEmojiTask) {
                        removeAsyncFileSaveTask(chatId, messageId, registeredEmojiTask.taskId);
                    }
                    if (registeredPreviewTask) {
                        removeAsyncPreviewTask(chatId, messageId, registeredPreviewTask.taskId);
                    }
                    if (registeredOcrTask) {
                        removeAsyncOcrTask(chatId, messageId, registeredOcrTask.taskId);
                    }
                    await next();
                    return;
                }

                if (customEmojiOccurrences.length > 0 && registeredEmojiTask) {
                    startCustomEmojiAcquisition(
                        bot,
                        revisionToken,
                        registeredEmojiTask.taskId
                    );
                }

                // Acquire media bytes asynchronously (download + optional .tgs->webm),
                // then update the saved message with the cache key or a corrected hint.
                if (media && registeredPrimaryTask) {
                    const primaryTaskId = registeredPrimaryTask.taskId;
                    // Hard backstop: never let the async-save flag stick (waitForFileSave
                    // would otherwise loop forever). Idempotent with the removal below.
                    const backstop = setTimeout(
                        () => removeAsyncFileSaveTask(chatId, messageId, primaryTaskId),
                        70000
                    );
                    void (async () => {
                        const [acquireErr, result] = await to(acquireMediaBytes(bot, media));
                        const outcome: AcquireResult = acquireErr || !result
                            ? { status: 'download_failed' }
                            : result;

                        const finalHint = mediaHintForAcquireResult(media, outcome);

                        const [saveErr] = await to(withBusyRetry(
                            () => updateMessageMediaForRevision(
                                revisionToken,
                                outcome.status === 'cached'
                                    ? {
                                        fileMime: outcome.mime,
                                        fileUniqueId: outcome.fileUniqueId,
                                        mediaHint: finalHint,
                                    }
                                    : { mediaHint: finalHint }
                            ),
                            `media update ${chatId}/${messageId}`
                        ));
                        if (saveErr) {
                            console.error('[autoSave] Failed to update message with media:', saveErr);
                        }
                        clearTimeout(backstop);
                        removeAsyncFileSaveTask(chatId, messageId, primaryTaskId);
                    })();
                }

                // Link preview: messages carrying a URL get their Telegram-side
                // preview (text + preview media) fetched live via luoxu and cached
                // by URL. Extracted from baseText — the exact string that gets
                // stored — so save-time and build-time extraction always agree.
                // The flag below only gates how long a reply waits; the
                // acquisition itself polls until Telegram confirms ready/none.
                let previewAcquisition: Promise<unknown> | undefined;
                if (previewUrl && registeredPreviewTask) {
                    const previewTaskId = registeredPreviewTask.taskId;
                    const previewBackstop = setTimeout(
                        () => removeAsyncPreviewTask(chatId, messageId, previewTaskId),
                        70000
                    );
                    previewAcquisition = (async () => {
                        const [previewErr] = await to(acquireLinkPreview(chatId, messageId, previewUrl));
                        if (previewErr) {
                            console.error('[autoSave] link preview acquire failed:', previewErr.message);
                        }
                        clearTimeout(previewBackstop);
                        removeAsyncPreviewTask(chatId, messageId, previewTaskId);
                    })();
                }

                // Bilifeed videos: archive a danmaku snapshot while the video is
                // still alive, so a later deletion can fall back to it.
                primeDanmakuSnapshot({
                    text: baseText,
                    viaBot: viaBot ?? null,
                    forwardOrigin: forwardOrigin ?? null,
                    mediaHint: media ? media.hint : null,
                });

                // OCR: recognize the text inside this message's images (its own,
                // plus the preview/IV images of its link) so models that cannot
                // see pictures still get their content. Fire-and-forget — only a
                // reply that actually needs it waits (see chat-handler).
                if (shouldAcquireOcr && registeredOcrTask) {
                    const ocrTaskId = registeredOcrTask.taskId;
                    const ocrBackstop = setTimeout(
                        () => removeAsyncOcrTask(chatId, messageId, ocrTaskId),
                        70000
                    );
                    void (async () => {
                        // A preview image's text is stored on the preview row, so
                        // that row has to exist first
                        if (previewAcquisition) await to(previewAcquisition);
                        const [ocrErr] = await to(acquireOcr(revisionToken, previewUrl));
                        if (ocrErr) {
                            console.error('[autoSave] ocr acquire failed:', ocrErr.message);
                        }
                        clearTimeout(ocrBackstop);
                        removeAsyncOcrTask(chatId, messageId, ocrTaskId);
                    })();
                }
            } catch (error) {
                // Loud and grep-able: this message is now missing from the
                // context tree, and only the backfill can bring it back.
                console.error(
                    `[autoSave] DROPPED message ${ctx.chat.id}/${ctx.message.message_id} from ${ctx.from.first_name}:`,
                    error
                );
                if (registeredPrimaryTask) {
                    removeAsyncFileSaveTask(
                        registeredPrimaryTask.chatId,
                        registeredPrimaryTask.messageId,
                        registeredPrimaryTask.taskId
                    );
                }
                if (registeredEmojiTask) {
                    removeAsyncFileSaveTask(
                        registeredEmojiTask.chatId,
                        registeredEmojiTask.messageId,
                        registeredEmojiTask.taskId
                    );
                }
                if (registeredPreviewTask) {
                    removeAsyncPreviewTask(
                        registeredPreviewTask.chatId,
                        registeredPreviewTask.messageId,
                        registeredPreviewTask.taskId
                    );
                }
                if (registeredOcrTask) {
                    removeAsyncOcrTask(
                        registeredOcrTask.chatId,
                        registeredOcrTask.messageId,
                        registeredOcrTask.taskId
                    );
                }
            }
        }

        await next();
    });
}


/**
 * Rows per delete/update statement. One big statement over blob-carrying tables
 * held the write lock for tens of seconds, and messages arriving in that window
 * were dropped (see docs/2026-0804-1858). Small statements let ingest interleave.
 */
const CLEANUP_BATCH_SIZE = 50;

/** Cleanup slower than this means the lock was contended — worth a look */
const CLEANUP_SLOW_MS = 2000;

/**
 * A message's key. The model has no declared surrogate id, and (chatId,
 * messageId) is indexed anyway.
 */
type MessageKey = { chatId: number; messageId: number };

const messageKeyOf = (row: Message): MessageKey => ({
    chatId: row.chatId,
    messageId: row.messageId,
});

/**
 * Apply `mutateChunk` to the keys in small batches, yielding to the event loop
 * between them so a pending write gets its turn at the lock.
 */
const mutateInChunks = async <T>(
    ids: T[],
    mutateChunk: (chunk: T[]) => Promise<unknown>
): Promise<number> => {
    for (let start = 0; start < ids.length; start += CLEANUP_BATCH_SIZE) {
        await mutateChunk(ids.slice(start, start + CLEANUP_BATCH_SIZE));
        await new Promise((resolve) => setImmediate(resolve));
    }
    return ids.length;
};

interface StaleMessageDeleteCounts {
    attachments: number;
    revisions: number;
    messages: number;
}

const deleteStaleMessagesInChunks = async (
    candidateKeys: MessageKey[],
    cutoff: Date
): Promise<StaleMessageDeleteCounts> => {
    const counts: StaleMessageDeleteCounts = { attachments: 0, revisions: 0, messages: 0 };
    for (let start = 0; start < candidateKeys.length; start += CLEANUP_BATCH_SIZE) {
        const candidates = candidateKeys.slice(start, start + CLEANUP_BATCH_SIZE);
        const deleted = await sequelize.transaction(async (transaction) => {
            const stillStale = await Message.findAll({
                where: {
                    [Op.and]: [
                        { [Op.or]: candidates },
                        { date: { [Op.lt]: cutoff.toISOString() } },
                    ],
                },
                attributes: ['chatId', 'messageId'],
                transaction,
            });
            const keys = stillStale.map(messageKeyOf);
            if (keys.length === 0) {
                return { attachments: 0, revisions: 0, messages: 0 };
            }
            const attachments = await MessageAttachment.destroy({
                where: { [Op.or]: keys },
                transaction,
            });
            const revisions = await MessageRevision.destroy({
                where: { [Op.or]: keys },
                transaction,
            });
            const messages = await Message.destroy({
                where: {
                    [Op.and]: [
                        { [Op.or]: keys },
                        { date: { [Op.lt]: cutoff.toISOString() } },
                    ],
                },
                transaction,
            });
            return { attachments, revisions, messages };
        });
        counts.attachments += deleted.attachments;
        counts.revisions += deleted.revisions;
        counts.messages += deleted.messages;
        await new Promise((resolve) => setImmediate(resolve));
    }
    return counts;
};

/**
 * One cleanup pass. Exported so the offline suite can run it directly instead of
 * waiting an hour for the timer.
 */
export const clearExpiredData = async (): Promise<void> => {
    const startedAt = Date.now();
    try {
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // 每一处都是「先按索引选 id（只读），再按主键分批删」，避免一条语句长时间独占写锁
        // 使用 UTC 时间，确保一致性
        const staleMessages = await Message.findAll({
            where: { date: { [Op.lt]: oneWeekAgo.toISOString() } },
            attributes: ['chatId', 'messageId'],
        });
        const staleMessageKeys = staleMessages.map(messageKeyOf);
        const staleMessageDeleteCounts = await deleteStaleMessagesInChunks(
            staleMessageKeys,
            oneWeekAgo
        );
        const attachmentResult = staleMessageDeleteCounts.attachments;
        const revisionResult = staleMessageDeleteCounts.revisions;
        const messageResult = staleMessageDeleteCounts.messages;

        // /chat 拉进上下文的边：消息本体都删了，边没有意义
        const staleLinks = await MessageLink.findAll({
            where: { createdAt: { [Op.lt]: oneWeekAgo } },
            attributes: ['id'],
        });
        const messageLinkResult = await mutateInChunks(
            staleLinks.map((row) => row.id),
            (chunk) => MessageLink.destroy({ where: { id: { [Op.in]: chunk } } })
        );

        // 清理 BotResponse 表
        const staleResponses = await BotResponse.findAll({
            where: { createdAt: { [Op.lt]: oneWeekAgo } },
            attributes: ['messageId'],
        });
        const botResponseResult = await mutateInChunks(
            staleResponses.map((row) => row.messageId),
            (chunk) => BotResponse.destroy({ where: { messageId: { [Op.in]: chunk } } })
        );

        // 媒体字节超过 1 天即清空，保留文字上下文（回复树仍按 id 引用旧消息）
        const messagesWithStaleBytes = await Message.findAll({
            where: {
                date: { [Op.lt]: oneDayAgo.toISOString() },
                file: { [Op.ne]: null },
            },
            attributes: ['chatId', 'messageId'],
        });
        const mediaClearedCount = await mutateInChunks(
            messagesWithStaleBytes.map(messageKeyOf),
            (chunk) => Message.update(
                { file: null, fileMime: null },
                { where: { [Op.or]: chunk } }
            )
        );

        // GCS 大文件引用超 1 天：删 GCS 对象 + 删缓存行（对齐媒体字节 1 天清空）
        const staleGcsRows = await MediaCache.findAll({
            where: { fileUri: { [Op.ne]: null }, createdAt: { [Op.lt]: oneDayAgo } },
        });
        for (const row of staleGcsRows) {
            if (row.fileUri) await deleteGcsObject(row.fileUri);
        }
        await mutateInChunks(
            staleGcsRows.map((row) => row.fileUniqueId),
            (chunk) => MediaCache.destroy({ where: { fileUniqueId: { [Op.in]: chunk } } })
        );

        // 共享媒体缓存按 LRU 清理：超 7 天未被命中续期的删除
        const staleMediaCache = await MediaCache.findAll({
            where: { lastUsedAt: { [Op.lt]: oneWeekAgo } },
            attributes: ['fileUniqueId'],
        });
        const mediaCacheResult = await mutateInChunks(
            staleMediaCache.map((row) => row.fileUniqueId),
            (chunk) => MediaCache.destroy({ where: { fileUniqueId: { [Op.in]: chunk } } })
        );

        const staleEmojiAssets = await CustomEmojiAsset.findAll({
            where: { lastUsedAt: { [Op.lt]: oneWeekAgo } },
            attributes: ['customEmojiId'],
        });
        const emojiAssetResult = await mutateInChunks(
            staleEmojiAssets.map((row) => row.customEmojiId),
            (chunk) => CustomEmojiAsset.destroy({ where: { customEmojiId: { [Op.in]: chunk } } })
        );

        // 链接预览缓存同节奏 LRU 清理（其媒体行已由上面的 MediaCache 清理覆盖）
        const stalePreviews = await LinkPreviewCache.findAll({
            where: { lastUsedAt: { [Op.lt]: oneWeekAgo } },
            attributes: ['url'],
        });
        const linkPreviewResult = await mutateInChunks(
            stalePreviews.map((row) => row.url),
            (chunk) => LinkPreviewCache.destroy({ where: { url: { [Op.in]: chunk } } })
        );

        const elapsedMs = Date.now() - startedAt;
        const summary = `Cleared ${messageResult} messages, ${attachmentResult} attachments, ${revisionResult} revisions, ${messageLinkResult} message links, ${botResponseResult} bot responses before ${oneWeekAgo.toISOString()}; cleared media bytes of ${mediaClearedCount} messages before ${oneDayAgo.toISOString()}; deleted ${staleGcsRows.length} GCS refs; evicted ${mediaCacheResult} media cache entries, ${emojiAssetResult} emoji assets, ${linkPreviewResult} link previews (${elapsedMs}ms)`;
        if (elapsedMs > CLEANUP_SLOW_MS) {
            console.warn(`[autoClear] slow cleanup — ${summary}`);
        } else {
            console.log(summary);
        }
    } catch (error) {
        console.error('Error during message cleanup:', error);
    }
};

// 自动清除一周前的消息
export const autoClear = () => {
    setInterval(() => void clearExpiredData(), 1000 * 60 * 60); // 每小时运行一次
}