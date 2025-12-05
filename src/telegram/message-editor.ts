/**
 * Rate-limited message editor for Telegram
 */
import type { Api } from 'grammy';
import { waitForRateLimit } from './rate-limiter';
import { to, isErr } from '../shared/result';

export interface EditOptions {
    parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    replyMarkup?: any;
    disableWebPagePreview?: boolean;
}

export interface MessageEditor {
    /**
     * Edit message text with rate limiting
     */
    edit: (text: string, options?: EditOptions) => Promise<boolean>;

    /**
     * Delete the message
     */
    delete: () => Promise<boolean>;

    /**
     * Get chat and message IDs
     */
    getIds: () => { chatId: number; messageId: number };
}

/**
 * Create a message editor for a specific message
 */
export const createMessageEditor = (
    api: Api,
    chatId: number,
    messageId: number
): MessageEditor => {
    return {
        edit: async (text: string, options?: EditOptions): Promise<boolean> => {
            await waitForRateLimit(chatId);

            const editResult = await to(
                api.editMessageText(chatId, messageId, text, {
                    parse_mode: options?.parseMode,
                    reply_markup: options?.replyMarkup,
                    link_preview_options: options?.disableWebPagePreview
                        ? { is_disabled: true }
                        : undefined,
                })
            );

            if (isErr(editResult)) {
                const err = editResult[0];

                // Ignore "message is not modified" error
                if (err.message?.includes('message is not modified')) {
                    return true;
                }

                console.error('[message-editor] Edit failed:', err.message);
                return false;
            }

            return true;
        },

        delete: async (): Promise<boolean> => {
            const deleteResult = await to(api.deleteMessage(chatId, messageId));

            if (isErr(deleteResult)) {
                console.error('[message-editor] Delete failed:', deleteResult[0].message);
                return false;
            }

            return true;
        },

        getIds: () => ({ chatId, messageId }),
    };
};

/**
 * Edit message text with rate limiting (standalone function)
 */
export const rateLimitedEdit = async (
    api: Api,
    chatId: number,
    messageId: number,
    text: string,
    options?: EditOptions
): Promise<boolean> => {
    const editor = createMessageEditor(api, chatId, messageId);
    return editor.edit(text, options);
};

/**
 * Create a processing message and return its editor
 */
export const createProcessingMessage = async (
    api: Api,
    chatId: number,
    replyToMessageId: number,
    initialText: string = 'Processing...'
): Promise<MessageEditor | null> => {
    const sendResult = await to(
        api.sendMessage(chatId, initialText, {
            reply_parameters: { message_id: replyToMessageId },
        })
    );

    if (isErr(sendResult)) {
        console.error('[message-editor] Failed to create processing message:', sendResult[0].message);
        return null;
    }

    const message = sendResult[1];
    return createMessageEditor(api, chatId, message.message_id);
};
