/**
 * Reference-image collection for the image-generation commands (/picgpt,
 * /picbanana), shared by the live command handlers and the retry paths.
 */
import { findBotResponseByMessageId, getMessage } from '../../db/index.js';
import { getFileContentsOfMessage } from '../../db/queries/context-queries.js';

/** Base64 images stored on one message row (media group sub-images included) */
const storedImagesOf = async (chatId: number, messageId: number): Promise<string[]> => {
    const images: string[] = [];
    const parts = await getFileContentsOfMessage(chatId, messageId);
    for (const part of parts) {
        if (part.type === 'image' && part.imageData) {
            images.push(part.imageData);
        }
    }
    return images;
};

/**
 * Base64 images attached to one message.
 *
 * A bot response is stored in the messages table under its FIRST message id,
 * while the picture the user actually sees is a later message with a different
 * id and no row of its own — so a missing row (or a bot row whose bytes the
 * daily media cleanup already dropped) is resolved through BotResponse, which
 * also keeps a base64 copy of the image per version. Without that step,
 * replying to a bot-generated picture yields no reference image at all.
 */
const imagesOfMessage = async (chatId: number, messageId: number): Promise<string[]> => {
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
    return versionImage ? [versionImage] : [];
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
        const images = await imagesOfMessage(chatId, messageId);
        images.forEach((image) => collected.add(image));
    }

    return [...collected];
};
