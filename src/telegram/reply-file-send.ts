/**
 * Putting a reply's file into the chat: one `sendDocument`, with the caption
 * the model wrote for it.
 *
 * A document is the only message type that keeps the file a file — a correct
 * name, downloadable and forwardable. The caption rules are the photo's rules
 * (same renderer, same 1024 limit, same retry without entities when Telegram
 * refuses them), so the shared helpers are reused instead of duplicated.
 *
 * Used by the final delivery and by version switching, so a re-sent file and a
 * fresh one take the same path.
 */
import { InputFile, type Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { FileDelivery } from '../ai/types.js';
import { sendWithCaptionFallback, type ImageCaptionFields } from '../reply/tools/image-message.js';
import { isErr, to, type Result } from '../shared/result.js';

export interface ReplyFileTarget {
    readonly reply_parameters: { readonly message_id: number };
    readonly reply_markup?: InlineKeyboardMarkup;
}

export interface SendReplyFileInput {
    readonly api: Api;
    readonly chatId: number;
    readonly file: FileDelivery;
    /** Rendered once, reused by the fallback */
    readonly captionFields: ImageCaptionFields;
    readonly target: ReplyFileTarget;
    /** The chat's rate limiter; 429s are absorbed here, not by the caller */
    readonly runApiCall: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const sendReplyFileMessage = async (input: SendReplyFileInput): Promise<Result<number>> => {
    const { api, chatId, file, target, runApiCall } = input;

    const sendAs = async (fields: ImageCaptionFields): Promise<Result<number>> => {
        // A fresh upload per attempt: a fallback must not reuse a consumed one
        const sent = await to(
            runApiCall(() =>
                api.sendDocument(chatId, new InputFile(file.data, file.name), {
                    ...target,
                    ...fields,
                    // Keep it a document with the name and type we chose
                    disable_content_type_detection: true,
                })
            )
        );
        if (isErr(sent)) return [sent[0], undefined];
        return [null, sent[1].message_id];
    };

    console.log(`[reply-file] sending ${file.name} (${file.mimeType}): ${file.data.length} bytes`);
    return sendWithCaptionFallback(input.captionFields, sendAs);
};
