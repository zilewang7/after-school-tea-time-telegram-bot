/**
 * Reference-image collection for the image-generation commands (/picgpt,
 * /picbanana) and the generate_image tool, shared by the live handlers and
 * the retry paths.
 */
import { findBotResponseByMessageId, getMessage } from '../../db/index.js';
import { getFileContentsOfMessage } from '../../db/queries/context-queries.js';
import { sniffImageMime } from '../../ai/image-generation/image-mime.js';

/** One image stored with a message */
export interface MessageImage {
    /** Base64 bytes */
    readonly data: string;
    /** MIME recorded with the bytes; image/png when none was (legacy rows, reply versions) */
    readonly mimeType: string;
}

/** Images stored on one message row, media group sub-images included, in context order */
const storedImagesOf = async (chatId: number, messageId: number): Promise<MessageImage[]> => {
    const parts = await getFileContentsOfMessage(chatId, messageId);
    return parts.flatMap((part) =>
        part.type === 'image' && part.imageData
            ? [{ data: part.imageData, mimeType: part.mimeType ?? 'image/png' }]
            : []
    );
};

/**
 * Images attached to one message.
 *
 * A bot response is stored in the messages table under its FIRST message id,
 * while the picture the user actually sees is a later message with a different
 * id and no row of its own — so a missing row (or a bot row whose bytes the
 * daily media cleanup already dropped) is resolved through BotResponse, which
 * also keeps a base64 copy of the image per version. Without that step,
 * replying to a bot-generated picture yields no reference image at all.
 */
export const loadMessageImages = async (chatId: number, messageId: number): Promise<MessageImage[]> => {
    const row = await getMessage(chatId, messageId);

    if (row) {
        const images = await storedImagesOf(chatId, messageId);
        // A user message has nothing else to fall back to
        if (images.length || !row.fromBotSelf) return images;
    }

    const botResponse = await findBotResponseByMessageId(chatId, messageId);
    if (!botResponse) return [];

    const anchoredImages = await storedImagesOf(chatId, botResponse.messageId);
    if (anchoredImages.length) return anchoredImages;

    const versionImage = botResponse.getCurrentVersion()?.imageBase64;
    if (!versionImage) return [];
    const bytes = Buffer.from(versionImage, 'base64');
    return [{ data: versionImage, mimeType: sniffImageMime(bytes) ?? 'image/png' }];
};

/**
 * Collect reference images from the given messages (typically the reply target
 * followed by the command message itself). De-duplicated, order preserved.
 */
export const collectReferenceImages = async (
    chatId: number,
    messageIds: Array<number | null | undefined>
): Promise<string[]> => {
    const collected = new Set<string>();

    for (const messageId of messageIds) {
        if (!messageId) continue;
        const images = await loadMessageImages(chatId, messageId);
        images.forEach((image) => collected.add(image.data));
    }

    return [...collected];
};
