/**
 * Rate-limited message editor for Telegram
 */
import type { Api } from 'grammy';
import { waitForRateLimit, recordEdit } from './rate-limiter';
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
    const doEdit = async (text: string, options?: EditOptions): Promise<boolean> => {
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
            const errMsg = err.message || '';

            // Ignore "message is not modified" error
            if (errMsg.includes('message is not modified')) {
                return true;
            }

            // Log parse errors specifically
            if (errMsg.includes("can't parse entities")) {
                console.warn('[message-editor] Markdown parse error:', errMsg);
            }

            console.error('[message-editor] Edit failed:', errMsg);
            return false;
        }

        // Record successful edit for rate limiting
        recordEdit(chatId);
        return true;
    };

    return {
        edit: (text: string, options?: EditOptions): Promise<boolean> => {
            return doEdit(text, options);
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
