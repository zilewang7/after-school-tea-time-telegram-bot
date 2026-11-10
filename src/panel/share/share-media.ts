/**
 * The bytes a public share page may show (design §5.6): only media of the
 * shared content itself, from the same 7-day cache the panel reads. A reply
 * share exposes its pinned version; a conversation share exposes messages that
 * belong to its tree. Large files are streamed from the GCS bucket.
 */
import { getMessage } from '../../db/index.js';
import { listExcludedMessageIds } from '../../db/queries/context-exclusions.js';
import { findBotResponseInChat, findRootMessage } from '../../db/queries/context-queries.js';
import {
    loadLinkPreviewMediaDescriptors,
    resolveCachedMediaByKey,
    resolveMessageMedia,
    resolveVersionMedia,
    type ResolvedMedia,
} from '../media/media-content.js';
import type { ShareRow } from './share-types.js';

/** `image` = the message's own visual media; `file` = its document; `preview` = a link preview item */
export type ShareMediaSlot = 'image' | 'file' | 'preview';

const parseSlot = (raw: string): ShareMediaSlot | null =>
    raw === 'image' || raw === 'file' || raw === 'preview' ? raw : null;

/** The media when it belongs in the requested slot; documents never render as pictures */
const withinSlot = (media: ResolvedMedia | null, slot: ShareMediaSlot): ResolvedMedia | null => {
    if (media === null) return null;
    return (media.kind === 'file') === (slot === 'file') ? media : null;
};

/** Whether a message belongs to the conversation a conversation share exposes */
const belongsToConversation = async (chatId: number, rootId: number, messageId: number): Promise<boolean> => {
    const chainRoot = await findRootMessage(chatId, messageId, { recover: false });
    return chainRoot?.messageId === rootId;
};

/**
 * One attachment of a share, or null when the share does not expose it.
 * `versionId` is the reply share's pinned version; conversation shares read
 * each bot message's current version, and user messages their own media.
 */
/** One captured link-preview item of a message, by its position in the bubble's list */
const previewMediaOf = async (
    chatId: number,
    messageId: number,
    index: number
): Promise<ResolvedMedia | null> => {
    const message = await getMessage(chatId, messageId);
    if (message === null) return null;
    const descriptors = await loadLinkPreviewMediaDescriptors([
        { messageId, text: message.text, fromBotSelf: false },
    ]);
    const preview = (descriptors.get(messageId) ?? [])[index];
    return preview === undefined ? null : resolveCachedMediaByKey(preview.mediaKey);
};

export const loadShareMedia = async (
    row: ShareRow,
    messageId: number,
    rawSlot: string,
    previewIndex = 0
): Promise<ResolvedMedia | null> => {
    const slot = parseSlot(rawSlot);
    if (slot === null) return null;

    if (row.kind === 'reply') {
        if (row.firstMessageId === null || row.firstMessageId !== messageId) return null;
        // A reply share is bot output only: it never exposes a user's link preview
        if (slot === 'preview') return null;
        return withinSlot(await resolveVersionMedia(row.chatId, messageId, row.versionId), slot);
    }

    if (row.rootId === null || !(await belongsToConversation(row.chatId, row.rootId, messageId))) return null;
    // The page never shows a message a member took out of the model's context
    const excluded = await listExcludedMessageIds(row.chatId);
    if (excluded.has(messageId)) return null;
    if (slot === 'preview') return previewMediaOf(row.chatId, messageId, previewIndex);
    const response = await findBotResponseInChat(row.chatId, messageId);
    if (response !== null) return withinSlot(await resolveVersionMedia(row.chatId, messageId, null), slot);
    if ((await getMessage(row.chatId, messageId)) === null) return null;
    return withinSlot(await resolveMessageMedia(row.chatId, messageId), slot);
};
