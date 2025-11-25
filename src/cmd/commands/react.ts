import { Bot } from "grammy";
import { matchFirstEmoji } from "../../util";

export const registerReactCommand = (bot: Bot) => {
    bot.command("react", (ctx) => {
        const firstEmoji = matchFirstEmoji(ctx.message?.text);
        const replyId = ctx.message?.reply_to_message?.message_id;
        const chatId = ctx.message?.chat.id;

        if (!firstEmoji) {
            ctx.reply("No emoji found");
            return;
        }

        if (!replyId || !chatId) {
            ctx.reply("No reply found");
            return;
        }

        ctx.api.setMessageReaction(chatId, replyId, [
            {
                type: "emoji",
                emoji: firstEmoji,
            },
        ]);
    });
};
