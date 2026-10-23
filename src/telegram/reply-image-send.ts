/**
 * Putting a reply's picture into the chat, in one place.
 *
 * A GIF must go out through `sendAnimation`: `sendPhoto` flattens it to a still
 * and `sendDocument` loses the inline preview. Photo and document stay as the
 * fallbacks, so a refused upload still gives the chat something.
 *
 * Used by both the final delivery and version switching, so a re-sent image and
 * a fresh one take the same path.
 */
import { GrammyError, type Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { sniffMediaMime } from '../ai/image-generation/image-mime.js';
import { imageInputFile, sendWithCaptionFallback, type ImageCaptionFields } from '../reply/tools/image-message.js';
import { isErr, to, type Result } from '../shared/result.js';

export interface ReplyImageTarget {
    readonly reply_parameters: { readonly message_id: number };
    readonly reply_markup?: InlineKeyboardMarkup;
}

export interface SendReplyImageInput {
    readonly api: Api;
    readonly chatId: number;
    readonly image: Buffer;
    /** Rendered once, reused by every fallback */
    readonly captionFields: ImageCaptionFields;
    readonly target: ReplyImageTarget;
    /** The chat's rate limiter; 429s are absorbed here, not by the caller */
    readonly runApiCall: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const sendReplyImageMessage = async (input: SendReplyImageInput): Promise<Result<number>> => {
    const { api, chatId, image, target, runApiCall } = input;
    const animated = sniffMediaMime(image) === 'image/gif';

    /**
     * A 400 while the caption carries entities is the caption's fault, not the
     * upload's: return it so `sendWithCaptionFallback` retries with plain text
     * instead of us downgrading the picture to a document.
     */
    const captionRefused = (error: unknown, fields: ImageCaptionFields): boolean =>
        error instanceof GrammyError && error.error_code === 400 && fields.caption_entities !== undefined;

    const sendAs = async (fields: ImageCaptionFields): Promise<Result<number>> => {
        const options = { ...target, ...fields };

        // A fresh InputFile per attempt: a fallback must not reuse a consumed one
        if (animated) {
            const animation = await to(runApiCall(() => api.sendAnimation(chatId, imageInputFile(image), options)));
            if (!isErr(animation)) return [null, animation[1].message_id];
            if (captionRefused(animation[0], fields)) return [animation[0], undefined];

            // The GIF file itself, still playable for the user
            const document = await to(runApiCall(() => api.sendDocument(chatId, imageInputFile(image), options)));
            if (!isErr(document)) return [null, document[1].message_id];

            // Last resort: a still is better than losing the picture entirely
            const photo = await to(runApiCall(() => api.sendPhoto(chatId, imageInputFile(image), options)));
            return isErr(photo) ? [photo[0], undefined] : [null, photo[1].message_id];
        }

        const photo = await to(runApiCall(() => api.sendPhoto(chatId, imageInputFile(image), options)));
        if (!isErr(photo)) return [null, photo[1].message_id];
        if (captionRefused(photo[0], fields)) return [photo[0], undefined];

        const document = await to(runApiCall(() => api.sendDocument(chatId, imageInputFile(image), options)));
        return isErr(document) ? [document[0], undefined] : [null, document[1].message_id];
    };

    console.log(`[reply-image] sending ${animated ? 'animation' : 'photo'}: ${image.length} bytes`);
    return sendWithCaptionFallback(input.captionFields, sendAs);
};
