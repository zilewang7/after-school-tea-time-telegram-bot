/**
 * Putting a reply's chat UI card into the chat.
 *
 * A private chat gets the card itself: one `sendWidget` call with the caption
 * the model wrote for it. The HTML is fixed once sent — there is no
 * edit-message-html method — so the delivery layer sends the final bytes
 * exactly once and stores the same bytes in the reply version for version
 * switching and for a later turn that wants to revise the card. A caption
 * Telegram refuses with entities is retried as plain text, the same rule the
 * photo and document paths use.
 *
 * A group chat gets the link fallback instead: a normal text message with the
 * Mini App link, previewing the reply's share page. It is sent through the
 * local client, so no widget-specific plumbing is needed.
 */
import type { Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { GrammyError } from 'grammy';
import type { WidgetDelivery } from '../ai/types.js';
import { sendWithCaptionFallback, type ImageCaptionFields } from '../reply/tools/image-message.js';
import type { WidgetLinkMessage } from '../reply/widget-link-fallback.js';
import { isErr, to, type Result } from '../shared/result.js';
import { runApiCall } from './edit-coordinator.js';
import { sendWidgetViaApi } from './widget-api.js';

export interface ReplyWidgetTarget {
    readonly reply_parameters: { readonly message_id: number };
    readonly reply_markup?: InlineKeyboardMarkup;
}

export interface SendReplyWidgetInput {
    readonly chatId: number;
    readonly widget: WidgetDelivery;
    /** Rendered caption fields; empty when the model wrote no caption */
    readonly captionFields: ImageCaptionFields;
    readonly target: ReplyWidgetTarget;
}

const captionRefused = (error: unknown, fields: ImageCaptionFields): boolean =>
    error instanceof GrammyError && error.error_code === 400 && fields.caption_entities !== undefined;

export const sendReplyWidgetMessage = async (
    input: SendReplyWidgetInput
): Promise<Result<number>> => {
    const { chatId, widget, target } = input;

    const sendAs = async (fields: ImageCaptionFields): Promise<Result<number>> => {
        const result = await sendWidgetViaApi({
            chat_id: chatId,
            html: widget.html,
            width: 0,
            height: 0,
            ...fields,
            ...target,
        });
        if (isErr(result) && captionRefused(result[0], fields)) return [result[0], undefined];
        return result;
    };

    console.log(
        `[reply-widget] sending widget (${widget.mode}): raw=${widget.htmlBytes} zlib=${widget.zlibBytes} bytes`
    );
    const result = await sendWithCaptionFallback(input.captionFields, sendAs);
    if (isErr(result)) {
        // A failed widget must not cost the reply: the caller turns this into a
        // visible line, the same way a failed image or file does.
        console.error(
            '[reply-widget] send failed:',
            result[0] instanceof Error ? result[0].message : String(result[0])
        );
    }
    return result;
};

export interface SendReplyWidgetLinkInput {
    readonly chatId: number;
    readonly message: WidgetLinkMessage;
    /** Version-switch buttons ride on the link message, like on any text message */
    readonly replyMarkup?: InlineKeyboardMarkup;
    /** grammY client to send through; the local one in production */
    readonly api: Api;
}

const sendWidgetLink = async (
    input: SendReplyWidgetLinkInput,
    withPreview: boolean
): Promise<Result<number>> => {
    const { message } = input;
    const [error, sent] = await to(
        runApiCall(input.chatId, () =>
            input.api.sendMessage(input.chatId, message.text, {
                entities: message.entities,
                ...(withPreview && message.linkPreviewOptions !== undefined
                    ? { link_preview_options: message.linkPreviewOptions }
                    : {}),
                ...(message.replyParameters !== undefined
                    ? { reply_parameters: message.replyParameters }
                    : {}),
                ...(input.replyMarkup !== undefined ? { reply_markup: input.replyMarkup } : {}),
            })
        )
    );
    return error !== null ? [error, undefined] : [null, sent.message_id];
};

/**
 * Send the link fallback. The share-page preview is best effort: Telegram may
 * be unable to fetch the page, and a message without the preview still carries
 * the Mini App link, so the send is retried once without `link_preview_options`
 * (Telegram then shows its own card for the t.me link).
 */
export const sendReplyWidgetLinkMessage = async (
    input: SendReplyWidgetLinkInput
): Promise<Result<number>> => {
    const wantsPreview = input.message.linkPreviewOptions !== undefined;
    const first = await sendWidgetLink(input, wantsPreview);
    if (!isErr(first) || !wantsPreview) return first;

    console.warn(
        '[reply-widget] link message with a share preview failed, retrying without it:',
        first[0] instanceof Error ? first[0].message : String(first[0])
    );
    const retried = await sendWidgetLink(input, false);
    if (isErr(retried)) {
        console.error(
            '[reply-widget] link message failed:',
            retried[0] instanceof Error ? retried[0].message : String(retried[0])
        );
    }
    return retried;
};
