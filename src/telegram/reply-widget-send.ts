/**
 * Putting a reply's chat UI card into the chat: one `sendWidget` call with the
 * caption the model wrote for it.
 *
 * The HTML is fixed once sent — there is no edit-message-html method — so the
 * delivery layer sends the final bytes exactly once and stores the same bytes
 * in the reply version for version switching and for a later turn that wants to
 * revise the card. A caption Telegram refuses with entities is retried as plain
 * text, the same rule the photo and document paths use.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { GrammyError } from 'grammy';
import type { WidgetDelivery } from '../ai/types.js';
import { sendWithCaptionFallback, type ImageCaptionFields } from '../reply/tools/image-message.js';
import { isErr, type Result } from '../shared/result.js';
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
