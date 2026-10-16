/**
 * Typing indicator management for Telegram
 */
import type { Api } from 'grammy';
import type { ToolChatAction } from '../ai/types.js';

export interface TypingIndicator {
    start: () => void;
    stop: () => void;
    isActive: () => boolean;
    /** Switch the chat action (e.g. upload_photo while a picture is drawn); sent at once when active */
    setAction: (action: ToolChatAction) => void;
}

/**
 * Create a typing indicator that sends typing action periodically
 */
export const createTypingIndicator = (
    api: Api,
    chatId: number,
    intervalMs: number = 5000
): TypingIndicator => {
    let interval: NodeJS.Timeout | undefined;
    let active = false;
    let currentAction: ToolChatAction = 'typing';

    const sendAction = () => {
        api.sendChatAction(chatId, currentAction).catch((err) => {
            console.error(`[typing] Failed to send ${currentAction} action:`, err.message);
        });
    };

    return {
        start: () => {
            if (active) return;
            active = true;
            sendAction();
            interval = setInterval(sendAction, intervalMs);
        },

        stop: () => {
            if (!active) return;
            active = false;
            if (interval) {
                clearInterval(interval);
                interval = undefined;
            }
        },

        isActive: () => active,

        setAction: (action: ToolChatAction) => {
            if (action === currentAction) return;
            currentAction = action;
            // Telegram shows an action for ~5s, so the switch would lag without this
            if (active) sendAction();
        },
    };
};

/**
 * Create a typing indicator with auto-cleanup on function completion
 */
export const withTypingIndicator = async <T>(
    api: Api,
    chatId: number,
    fn: () => Promise<T>
): Promise<T> => {
    const typing = createTypingIndicator(api, chatId);
    typing.start();

    try {
        return await fn();
    } finally {
        typing.stop();
    }
};
