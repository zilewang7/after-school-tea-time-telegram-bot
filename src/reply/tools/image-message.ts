/**
 * The message a reply's image goes out as: the upload, named after its real
 * format, and the caption the model wrote for it.
 *
 * The caption is rendered like the reply text (same markdown renderer, `#N`
 * made clickable) and cut to fit Telegram's caption limit. Used by the final
 * delivery and by version switching, so a re-sent image keeps its caption.
 */
import { GrammyError, InputFile } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { concatMessages, renderMarkdown, splitMessage } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import { imageFileName } from '../../ai/image-generation/image-mime.js';
import type { Result } from '../../shared/result.js';
import { toApiEntities } from '../../telegram/api-entities.js';
import {
    linkifyContextNumbers,
    type ContextLinkResolver,
} from '../../telegram/formatters/context-links.js';

/** Telegram's caption limit; counted in UTF-16 units here, which never undercounts */
export const IMAGE_CAPTION_MAX_LENGTH = 1024;
/** Same headroom as the reply text: the server drops entities past ~100 */
const IMAGE_CAPTION_MAX_ENTITIES = 90;
const TRUNCATION_MARK = '…';

/** Caption fields of a sendPhoto / sendDocument call; empty without a caption */
export interface ImageCaptionFields {
    readonly caption?: string;
    readonly caption_entities?: MessageEntity[];
}

const NO_CAPTION: ImageCaptionFields = {};
const EMPTY_MESSAGE: RenderedMessage = { text: '', entities: [] };

const splitCaption = (rendered: RenderedMessage, maxLength: number): RenderedMessage[] =>
    splitMessage(rendered, { maxLength, maxEntities: IMAGE_CAPTION_MAX_ENTITIES });

/** The whole caption when it fits, else its fitting head closed with a mark */
const fitCaption = (rendered: RenderedMessage): RenderedMessage => {
    const chunks = splitCaption(rendered, IMAGE_CAPTION_MAX_LENGTH);
    if (chunks.length <= 1) return chunks[0] ?? EMPTY_MESSAGE;

    // Cut again, leaving room for the mark; the split clips entities at the cut
    const [head] = splitCaption(rendered, IMAGE_CAPTION_MAX_LENGTH - TRUNCATION_MARK.length);
    return concatMessages(head ?? EMPTY_MESSAGE, TRUNCATION_MARK);
};

export const buildImageCaption = (
    caption: string | undefined,
    resolveContextLink?: ContextLinkResolver
): ImageCaptionFields => {
    if (!caption?.trim()) return NO_CAPTION;

    // Linkified before fitting, so the link entities count against the budget
    const fitted = fitCaption(linkifyContextNumbers(renderMarkdown(caption), resolveContextLink));
    if (!fitted.text.trim()) return NO_CAPTION;

    return fitted.entities.length > 0
        ? { caption: fitted.text, caption_entities: toApiEntities(fitted.entities) }
        : { caption: fitted.text };
};

/** A fresh upload per call: a fallback send must not reuse a consumed one */
export const imageInputFile = (data: Buffer): InputFile => new InputFile(data, imageFileName(data));

/**
 * Send an image with its caption; when Telegram refuses the send with a 400
 * and the caption carries entities, send it once more with the caption as
 * plain text. The same safety net the edit coordinator gives the reply text:
 * a caption Telegram cannot take must not cost the image.
 */
export const sendWithCaptionFallback = async <SendResult extends Result<unknown>>(
    captionFields: ImageCaptionFields,
    send: (fields: ImageCaptionFields) => Promise<SendResult>
): Promise<SendResult> => {
    const result = await send(captionFields);
    const [error] = result;
    if (error === null) return result;

    const { caption, caption_entities: captionEntities } = captionFields;
    const refused = error instanceof GrammyError && error.error_code === 400;
    if (!refused || caption === undefined || captionEntities === undefined) return result;

    console.error('[image-message] Image send with caption entities refused, retrying with a plain caption:', error.message);
    return send({ caption });
};
