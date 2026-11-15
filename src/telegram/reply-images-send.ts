/**
 * A reply's pictures as trailing messages: one message for one picture, an
 * album for several stills, single animation messages for GIFs.
 *
 * Telegram's `sendMediaGroup` is the only way several pictures arrive as one
 * unit: 2–10 stills, each with its own caption, replying to the question but
 * unable to carry an inline keyboard. The caller therefore puts the buttons on
 * the first returned message afterwards (`editMessageReplyMarkup`), which is
 * what it already does for a single image.
 *
 * The fallbacks are deliberate: a refused album degrades to one send per
 * picture (the same sender a single image takes), and a picture even that
 * cannot send is dropped with a log — the reply's text must not be lost to a
 * picture problem. A GIF never enters an album (Telegram would flatten it to a
 * still) and goes out through the animation sender, after the stills.
 */
import { InputFile, InputMediaBuilder, type Api } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { imageFileName, sniffMediaMime } from '../ai/image-generation/image-mime.js';
import { MAX_ALBUM_IMAGES, MIN_ALBUM_IMAGES } from '../shared/reply-media.js';
import { to, type Result } from '../shared/result.js';
import { sendReplyImageMessage, type ReplyImageTarget } from './reply-image-send.js';

/** Caption fields one album item (or one single picture) goes out with */
export interface ReplyImageCaption {
    readonly caption?: string;
    readonly caption_entities?: MessageEntity[];
}

/** One picture about to be delivered, in delivery order */
export interface ReplyImageUpload {
    readonly data: Buffer;
    /** Rendered already; an absent caption sends the picture bare */
    readonly captionFields?: ReplyImageCaption;
}

export interface SendReplyImagesInput {
    readonly api: Api;
    readonly chatId: number;
    /** Pictures in the order the reply should show them */
    readonly images: readonly ReplyImageUpload[];
    /** Reply target; `reply_markup` is honoured by single sends only (albums take none) */
    readonly target: ReplyImageTarget;
    /** The chat's rate limiter; 429s are absorbed there, not here */
    readonly runApiCall: <T>(operation: () => Promise<T>) => Promise<T>;
    /**
     * Whether several stills become one album. False sends each still as its
     * own message (the keyboard has to land on the last one when the reply has
     * no text message to carry it).
     */
    readonly useAlbum?: boolean;
    /** Called with the input index of a picture that could not be sent at all */
    readonly onDropped?: (index: number) => void;
}

/** A fresh upload per attempt: a fallback must not reuse a consumed one */
const uploadOf = (image: ReplyImageUpload): InputFile => new InputFile(image.data, imageFileName(image.data));

const isAnimated = (image: ReplyImageUpload): boolean => sniffMediaMime(image.data) === 'image/gif';

/**
 * The stills in one album call; null when Telegram refused it (the caller then
 * sends them one by one, which also gives each caption its own plain-text
 * fallback through the single-image sender).
 */
const sendAlbum = async (
    input: SendReplyImagesInput,
    stills: readonly ReplyImageUpload[]
): Promise<Result<number[]>> => {
    const media = stills.map((image) => {
        const caption = image.captionFields;
        return caption === undefined
            ? InputMediaBuilder.photo(uploadOf(image))
            : InputMediaBuilder.photo(uploadOf(image), {
                  ...(caption.caption === undefined ? {} : { caption: caption.caption }),
                  ...(caption.caption_entities === undefined
                      ? {}
                      : { caption_entities: caption.caption_entities }),
              });
    });

    const sent = await to(
        input.runApiCall(() =>
            input.api.sendMediaGroup(input.chatId, media, {
                reply_parameters: input.target.reply_parameters,
            })
        )
    );
    if (sent[0] !== null) {
        console.warn(
            `[reply-images] album of ${stills.length} was refused, sending one by one: ${sent[0].message}`
        );
        return [sent[0], undefined];
    }
    return [null, sent[1].map((message) => message.message_id)];
};

/** One picture through the single-image sender (photo→document, animation fallbacks) */
const sendOne = async (
    input: SendReplyImagesInput,
    image: ReplyImageUpload
): Promise<Result<number>> =>
    sendReplyImageMessage({
        api: input.api,
        chatId: input.chatId,
        image: image.data,
        captionFields: image.captionFields ?? {},
        // The keyboard still rides the only picture when the reply has one;
        // with several the caller edits it onto the first returned message
        target: input.target,
        runApiCall: input.runApiCall,
    });

/** Send one picture either way; null when it was dropped (logged here once) */
const sendOneOrNull = async (
    input: SendReplyImagesInput,
    image: ReplyImageUpload,
    index: number
): Promise<number | null> => {
    const single = await sendOne(input, image);
    if (single[0] !== null) {
        console.error('[reply-images] picture dropped after a refused send:', single[0].message);
        input.onDropped?.(index);
        return null;
    }
    return single[1];
};

/**
 * Send every picture of the reply after its text. Stills go first (album when
 * there are several, one message when there is one), animations after them.
 * The returned ids follow the actual delivery order, which is the order the
 * reply's message ids must keep; a picture that cannot be sent is dropped.
 * An error means no picture went out at all.
 */
export const sendReplyImagesMessage = async (input: SendReplyImagesInput): Promise<Result<number[]>> => {
    const { images } = input;
    if (images.length === 0) return [new Error('the reply has no images to send'), undefined];

    const stills = images.filter((image) => !isAnimated(image));
    const animations = images.filter(isAnimated);
    const messageIds: number[] = [];

    // One picture of any kind takes the path the reply always took
    if (images.length === 1) {
        const only = images[0];
        if (only === undefined) return [new Error('the reply has no images to send'), undefined];
        const sent = await sendOne(input, only);
        return sent[0] !== null ? [sent[0], undefined] : [null, [sent[1]]];
    }

    if (stills.length >= MIN_ALBUM_IMAGES && input.useAlbum !== false) {
        const album = await sendAlbum(input, stills.slice(0, MAX_ALBUM_IMAGES));
        if (album[0] === null) {
            messageIds.push(...album[1]);
        } else {
            // Album refused: the same pictures go out one message each
            for (const image of stills.slice(0, MAX_ALBUM_IMAGES)) {
                const sent = await sendOneOrNull(input, image, input.images.indexOf(image));
                if (sent !== null) messageIds.push(sent);
            }
        }
    } else {
        // One still, or an album is not allowed for this delivery: one message each
        for (const image of stills.slice(0, MAX_ALBUM_IMAGES)) {
            const sent = await sendOneOrNull(input, image, input.images.indexOf(image));
            if (sent !== null) messageIds.push(sent);
        }
    }

    // Past an album's size there is no Telegram shape for them: drop the rest
    // loudly instead of sending a second album
    for (const extra of stills.slice(MAX_ALBUM_IMAGES)) {
        console.warn(`[reply-images] still picture beyond ${MAX_ALBUM_IMAGES} dropped`);
        input.onDropped?.(input.images.indexOf(extra));
    }

    // Animations never ride an album; each is its own message, after the stills
    for (const animation of animations) {
        const sent = await sendOneOrNull(input, animation, input.images.indexOf(animation));
        if (sent !== null) messageIds.push(sent);
    }

    if (messageIds.length === 0) {
        return [new Error('no picture of the reply could be sent'), undefined];
    }
    return [null, messageIds];
};
