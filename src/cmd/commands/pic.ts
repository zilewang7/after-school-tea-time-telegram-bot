import { Bot } from "grammy";
import { removeSpecificText } from "../../util";
import { grokAgent } from "../../openai";

export const registerPicCommands = (bot: Bot) => {
    bot.command("picgrok", async (ctx) => {
        if (!ctx.message?.text) {
            return;
        }

        const command = ctx.message?.text.split(" ")[0];

        const msg = removeSpecificText(ctx.message.text, command);

        try {
            if (!ctx.match) {
                await ctx.reply("No input found");
                return;
            }

            const response = await grokAgent.images.generate({
                model: "grok-2-image-1212",
                prompt: msg,
            });

            if (!response.data?.[0]?.url) {
                throw new Error("No image URL found in response");
            }

            await ctx.replyWithPhoto(response.data[0].url);

            return;
        } catch (error) {
            console.error('Error fetching and sending photo:', error);
            ctx.reply('无法获取图片，请稍后再试。');
        }
    });
};
