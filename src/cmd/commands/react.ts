import type { Bot } from "grammy";
import { recordBotReaction } from "../../db/queries/reaction-queries.js";
import { matchFirstEmoji } from "../../util.js";

export const registerReactCommand = (bot: Bot) => {
    bot.command("react", async (ctx) => {
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

        try {
            await ctx.api.setMessageReaction(chatId, replyId, [
                {
                    type: "emoji",
                    emoji: firstEmoji,
                },
            ]);
        } catch (error) {
            console.warn('[react] failed to set the reaction:', error instanceof Error ? error.message : error);
            return;
        }
        // Recorded locally: the Bot API never reports the bot's own reaction as
        // an update, and the next runtime block should show what it did.
        await recordBotReaction(chatId, replyId, firstEmoji);
    });
};
