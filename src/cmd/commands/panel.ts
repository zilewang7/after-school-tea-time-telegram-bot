import type { Bot } from "grammy";
import type { Chat } from "grammy/types";
import { match } from "ts-pattern";
import { upsertChatNow } from "../../db/queries/panel-registry.js";
import { isPanelRunning } from "../../panel/panel-state.js";
import { miniAppKeyboardForChat } from "./mini-app-link.js";

const OPEN_PANEL_LABEL = "打开面板";

type PanelReply =
    | { kind: 'text'; text: string }
    | { kind: 'button'; text: string; keyboard: NonNullable<ReturnType<typeof miniAppKeyboardForChat>> };

const disabledReply: PanelReply = { kind: 'text', text: "面板未启用" };

const unsupportedReply: PanelReply = { kind: 'text', text: "这里不支持控制面板" };

/**
 * Private chats open the Mini App in place; groups cannot carry web_app buttons,
 * so they get a Direct Link whose signed start_param `c<chatId>` lands the panel
 * on this chat.
 */
const panelReplyFor = (chat: Chat): PanelReply => {
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
        const reply = panelReplyFor(ctx.chat);
        await match(reply)
            .with({ kind: 'text' }, (textReply) => ctx.reply(textReply.text))
            .with({ kind: 'button' }, (buttonReply) =>
                ctx.reply(buttonReply.text, { reply_markup: buttonReply.keyboard })
            )
            .exhaustive();
    });
};
