import { Bot, InlineKeyboard } from "grammy";
import type { Chat } from "grammy/types";
import { match } from "ts-pattern";
import { upsertChatNow } from "../../db/queries/panel-registry.js";
import { isPanelRunning } from "../../panel/panel-state.js";

const OPEN_PANEL_LABEL = "打开面板";
const DEFAULT_SHORT_NAME = "panel";

type PanelReply =
    | { kind: 'text'; text: string }
    | { kind: 'button'; text: string; keyboard: InlineKeyboard };

const disabledReply: PanelReply = { kind: 'text', text: "面板未启用" };

/** Private chats open the Mini App in place: a web_app button */
const privateChatReply = (): PanelReply => {
    const url = process.env.WEBAPP_PUBLIC_URL?.trim();
    if (!url) return disabledReply;
    return { kind: 'button', text: "控制面板：", keyboard: new InlineKeyboard().webApp(OPEN_PANEL_LABEL, url) };
};

/**
 * Groups cannot carry web_app buttons: a Direct Link instead, whose signed
 * start_param `c<chatId>` lands the panel on this chat.
 */
const groupChatReply = (chatId: number): PanelReply => {
    const botUserName = process.env.BOT_USER_NAME?.trim();
    if (!botUserName) return disabledReply;
    const shortName = process.env.WEBAPP_BOT_SHORT_NAME?.trim() || DEFAULT_SHORT_NAME;
    const url = `https://t.me/${botUserName}/${shortName}?startapp=c${chatId}`;
    return { kind: 'button', text: "本聊天的控制面板：", keyboard: new InlineKeyboard().url(OPEN_PANEL_LABEL, url) };
};

const panelReplyFor = (chat: Chat): PanelReply =>
    match(chat.type)
        .returnType<PanelReply>()
        .with('private', () => privateChatReply())
        .with('group', 'supergroup', () => groupChatReply(chat.id))
        .otherwise(() => ({ kind: 'text', text: "这里不支持控制面板" }));

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
