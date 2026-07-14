/**
 * One-shot message editor for Telegram, routed through the edit coordinator
 * (shared per-chat budget, 429 backoff, sticky delivery)
 */
import type { Api } from 'grammy';
import type { MessageEntity as RenderedEntity } from 'telegram-md-entities';
import { to, isErr } from '../shared/result.js';
import { submitEdit, dropMessageState, runApiCall } from './edit-coordinator.js';

export interface EditOptions {
    /** Pre-rendered entities for the text */
    entities?: readonly RenderedEntity[];
    replyMarkup?: any;
    disableWebPagePreview?: boolean;
}

export interface MessageEditor {
    /**
     * Edit message text; resolves true once delivered (retried on 429)
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
        edit: (text: string, options?: EditOptions): Promise<boolean> => {
            return submitEdit(api, chatId, messageId, text, {
                entities: options?.entities,
                replyMarkup: options?.replyMarkup,
                linkPreviewDisabled: options?.disableWebPagePreview,
                isFinal: true,
            });
        },

        delete: async (): Promise<boolean> => {
            dropMessageState(chatId, messageId);
            const deleteResult = await to(
                runApiCall(chatId, () => api.deleteMessage(chatId, messageId))
            );

            if (isErr(deleteResult)) {
                console.error('[message-editor] Delete failed:', deleteResult[0].message);
                return false;
            }

            return true;
        },

        getIds: () => ({ chatId, messageId }),
    };
};
