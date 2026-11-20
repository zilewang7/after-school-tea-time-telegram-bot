import type { Bot, InlineKeyboard } from "grammy";
import type { Chat } from "grammy/types";
import { match } from "ts-pattern";
import { findConversationRootId } from "../../db/queries/context-queries.js";
import { upsertChatNow } from "../../db/queries/panel-registry.js";
import { isPanelRunning } from "../../panel/panel-state.js";
import { registerConversationKeyboardMessage } from "../../state.js";
import { miniAppConversationKeyboardForChat, miniAppDirectLink, miniAppKeyboardForChat } from "./mini-app-link.js";

const OPEN_PANEL_LABEL = "打开面板";
const OPEN_CONVERSATION_LABEL = "打开这条会话";

type PanelReply =
    | { kind: 'text'; text: string }
    | { kind: 'button'; text: string; keyboard: InlineKeyboard; receiptRootId?: number };

const disabledReply: PanelReply = { kind: 'text', text: "面板未启用" };

const unsupportedReply: PanelReply = { kind: 'text', text: "这里不支持控制面板" };

/**
 * Private chats open the Mini App in place; groups cannot carry web_app buttons,
 * so they get a Direct Link whose signed start_param `c<chatId>` lands the panel
 * on this chat.
 */
const chatPanelReplyFor = (chat: Chat): PanelReply => {
    if (chat.type !== 'private' && chat.type !== 'group' && chat.type !== 'supergroup') {
        return unsupportedReply;
    }
    const startParam = chat.type === 'private' ? undefined : `c${chat.id}`;
    const keyboard = miniAppKeyboardForChat(chat, OPEN_PANEL_LABEL, startParam);
    if (keyboard === null) return disabledReply;
    return {
        kind: 'button',
        text: chat.type === 'private' ? "控制面板：" : "本聊天的控制面板：",
        keyboard,
    };
};

/**
 * The deep link to the conversation the replied message belongs to; null when
 * the message is not part of a stored conversation (the chat-level reply then
 * applies).
 */
const conversationPanelReplyFor = async (chat: Chat, repliedMessageId: number): Promise<PanelReply | null> => {
    const rootId = await findConversationRootId(chat.id, repliedMessageId);
    if (rootId === null) return null;
    const startParam = `c${chat.id}_${rootId}`;
    // Only a Direct Link carries the target: without BOT_USER_NAME the chat-level
    // reply below is what the chat gets, exactly as before this feature
    if (miniAppDirectLink(startParam) === null) return null;
    const keyboard = miniAppConversationKeyboardForChat(chat, OPEN_CONVERSATION_LABEL, startParam);
    if (keyboard === null) return null;
    // The panel appends its operations to this message (design §4.7): remember it
    return { kind: 'button', text: "这条会话的控制面板：", keyboard, receiptRootId: rootId };
};

/** A reply to one message deep-links into its conversation; anything else stays chat-level */
const panelReplyFor = async (chat: Chat, repliedMessageId: number | undefined): Promise<PanelReply> => {
    if (chat.type !== 'private' && chat.type !== 'group' && chat.type !== 'supergroup') {
        return unsupportedReply;
    }
    if (repliedMessageId !== undefined) {
        const conversationReply = await conversationPanelReplyFor(chat, repliedMessageId);
        if (conversationReply !== null) return conversationReply;
    }
    return chatPanelReplyFor(chat);
};

/** /panel: a button that opens the control panel; not subject to pausing */
export const registerPanelCommand = (bot: Bot) => {
    bot.command("panel", async (ctx) => {
        // Unset WEBAPP_PORT (or a failed listen): there is nothing to open
        if (!isPanelRunning()) {
            await ctx.reply(disabledReply.text);
            return;
        }
        // Right away (no debounce): a chat new to the registry can be opened at once
        await upsertChatNow(ctx.chat).catch((error: unknown) => {
            console.error(`[panel] /panel could not register chat ${ctx.chat.id}:`, error);
        });
        const reply = await panelReplyFor(ctx.chat, ctx.message?.reply_to_message?.message_id);
        await match(reply)
            .with({ kind: 'text' }, (textReply) => ctx.reply(textReply.text))
            .with({ kind: 'button' }, async (buttonReply) => {
                const sent = await ctx.reply(buttonReply.text, { reply_markup: buttonReply.keyboard });
                // The panel appends what it did to this message: the chat keeps a
                // readable receipt of the operations (design 2026-1119-2016 §4.7)
                if (buttonReply.receiptRootId !== undefined) {
                    registerConversationKeyboardMessage({
                        chatId: ctx.chat.id,
                        rootId: buttonReply.receiptRootId,
                        messageId: sent.message_id,
                        baseText: buttonReply.text,
                        replyMarkup: buttonReply.keyboard,
                    });
                }
            })
            .exhaustive();
    });
};
