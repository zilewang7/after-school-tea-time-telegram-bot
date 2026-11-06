/**
 * What a paused chat answers with instead of a reply: a 😴 reaction on the
 * trigger message, or a toast on a regenerate button. Messages are still
 * stored and `/model` still works; only generation stops.
 */
import type { Context } from 'grammy';
import { isChatPaused } from '../services/chat-settings-service.js';

/** Toast for a regenerate button (reply retry, 🎲 / 🔄 / ✍️) in a paused chat */
export const PAUSED_CALLBACK_NOTICE = '本聊天已暂停';

/** Whether the chat a button sits in is paused; inline messages have no chat */
export const isCallbackChatPaused = (ctx: Context): boolean => {
    const chatId = ctx.callbackQuery?.message?.chat.id;
    return chatId !== undefined && isChatPaused(chatId);
};

/**
 * When the message's chat is paused, react 😴 to it and return true so the
 * caller stops. A failed reaction (no permission, deleted message) is ignored:
 * the pause holds either way.
 */
export const stopIfChatPaused = async (ctx: Context): Promise<boolean> => {
    if (!ctx.chat || !ctx.message || !isChatPaused(ctx.chat.id)) return false;
    try {
        await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '😴' }]);
    } catch (error) {
        console.warn('[chat-pause] paused reaction failed:', error instanceof Error ? error.message : error);
    }
    return true;
};
