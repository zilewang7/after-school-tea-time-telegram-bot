/**
 * Typing indicator management for Telegram
 */
import type { Api } from 'grammy';

export interface TypingIndicator {
    start: () => void;
    stop: () => void;
    isActive: () => boolean;
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

    const sendTyping = () => {
        api.sendChatAction(chatId, 'typing').catch((err) => {
            console.error('[typing] Failed to send typing action:', err.message);
        });
    };

    return {
        start: () => {
            if (active) return;
            active = true;
            sendTyping();
            interval = setInterval(sendTyping, intervalMs);
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
