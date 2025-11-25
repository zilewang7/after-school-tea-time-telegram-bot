import { Bot } from "grammy";
import { removeSpecificText } from "../../util";
import { generateImageByPrompt } from "../../openai/image-generate";

export const registerPicCommands = (bot: Bot) => {
    bot.command(["pic", "pic1", "pic2", "pic3", "picgrok"], async (ctx) => {
        if (!ctx.message?.text) {
            return;
        }

        const command = ctx.message?.text.split(" ")[0];

        if (!command?.startsWith("/pic")) {
            return;
        }

        const model = command.replace("/pic", "") || "1";

        const msg = removeSpecificText(ctx.message.text, command);
        await generateImageByPrompt(ctx, model, msg);
    });
};
