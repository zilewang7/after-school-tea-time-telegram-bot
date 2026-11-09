/**
 * The bytes a public share page may show (design §5.6): only media of the
 * shared content itself. A reply share exposes its pinned version; a
 * conversation share exposes messages that belong to its tree. GCS-backed
 * files (no inline bytes) and files over the inline limit are refused.
 */
import { getMessage } from '../../db/index.js';
import type { BotResponse } from '../../db/index.js';
import { listExcludedMessageIds } from '../../db/queries/context-exclusions.js';
import { findBotResponseInChat, findRootMessage } from '../../db/queries/context-queries.js';
import { sniffMediaMime } from '../../ai/image-generation/image-mime.js';
import { selectVersion } from './share-content.js';
import type { ShareRow } from './share-types.js';

/** Inline media only; anything larger is not proxied to the public */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export type ShareMediaSlot = 'image' | 'file';

export interface ShareMedia {
    data: Buffer;
    mimeType: string;
}

const parseSlot = (raw: string): ShareMediaSlot | null => (raw === 'image' || raw === 'file' ? raw : null);

const withinLimit = (media: ShareMedia | null): ShareMedia | null =>
    media !== null && media.data.length <= MAX_MEDIA_BYTES ? media : null;

/** The pinned/current version's image or file bytes */
const botMediaOf = (response: BotResponse, versionId: number | null, slot: ShareMediaSlot): ShareMedia | null => {
    const selected = selectVersion(response, versionId);
    if (selected === null) return null;
    const version = selected.version;
    if (slot === 'image') {
        const widgetImage = version.widget?.imageBase64;
        if (typeof widgetImage === 'string' && widgetImage !== '') {
            return { data: Buffer.from(widgetImage, 'base64'), mimeType: 'image/png' };
        }
        const imageBase64 = version.imageBase64;
        if (typeof imageBase64 === 'string' && imageBase64 !== '') {
            const data = Buffer.from(imageBase64, 'base64');
            return { data, mimeType: sniffMediaMime(data) ?? 'image/png' };
        }
        return null;
    }
    const file = version.file;
    const fileBase64 = version.fileBase64;
    if (file === undefined || typeof fileBase64 !== 'string' || fileBase64 === '') return null;
    return { data: Buffer.from(fileBase64, 'base64'), mimeType: file.mimeType };
};

/** A message's own inline image; documents and GCS-backed media are not proxied */
const userMediaOf = async (chatId: number, messageId: number, slot: ShareMediaSlot): Promise<ShareMedia | null> => {
    if (slot !== 'image') return null;
    const message = await getMessage(chatId, messageId);
    if (message === null || message.file === null || message.file.length === 0) return null;
    const mimeType = (message.fileMime ?? '').toLowerCase();
    if (!mimeType.startsWith('image/')) return null;
    return { data: Buffer.from(message.file), mimeType: message.fileMime ?? 'image/png' };
};

/** Whether a message belongs to the conversation a conversation share exposes */
const belongsToConversation = async (chatId: number, rootId: number, messageId: number): Promise<boolean> => {
    const chainRoot = await findRootMessage(chatId, messageId, { recover: false });
    return chainRoot?.messageId === rootId;
};

/**
 * One attachment of a share, or null when the share does not expose it.
 * `versionId` is the reply share's pinned version; conversation shares read
 * each bot message's current version.
 */
export const loadShareMedia = async (
    row: ShareRow,
    messageId: number,
    rawSlot: string
): Promise<ShareMedia | null> => {
    const slot = parseSlot(rawSlot);
    if (slot === null) return null;

    if (row.kind === 'reply') {
        if (row.firstMessageId === null || row.firstMessageId !== messageId) return null;
        const response = await findBotResponseInChat(row.chatId, messageId);
        return response === null ? null : withinLimit(botMediaOf(response, row.versionId, slot));
    }

    if (row.rootId === null || !(await belongsToConversation(row.chatId, row.rootId, messageId))) return null;
    // The page never shows a message a member took out of the model's context
    const excluded = await listExcludedMessageIds(row.chatId);
    if (excluded.has(messageId)) return null;
    const response = await findBotResponseInChat(row.chatId, messageId);
    if (response !== null) return withinLimit(botMediaOf(response, null, slot));
    return withinLimit(await userMediaOf(row.chatId, messageId, slot));
};
