import { Bot } from "grammy";
import { getRepliesHistory } from "../../reply/helper";

export const registerContextCommand = (bot: Bot) => {
    bot.command("context", async (ctx) => {
        try {
            if (!ctx.message || !ctx.chat) {
                return;
            }

            if (!ctx.message.reply_to_message) {
                ctx.reply("请回复要查看的消息");
                return;
            }

            const originalMessages = await getRepliesHistory(
                ctx.chat.id,
                ctx.message.reply_to_message.message_id,
                { excludeSelf: false }
            );

            if (originalMessages[0]) {
                const isSupergroup = ctx.chat.type === "supergroup";
                const firstMsg = originalMessages[0];

                let replyText =
                    "*当前会话上下文:*" +
                    (isSupergroup
                        ? ` [初始消息](https://t.me/c/${String(firstMsg.chatId).slice(4)}/${firstMsg.messageId
                        })`
                        : "") +
                    "\n\n**";

                originalMessages.forEach((msg, index) => {
                    let shortMsg = msg.text || "";
                    if (shortMsg.length > 12) {
                        shortMsg = Array.from(shortMsg).slice(0, 10).join("") + "...";
                    }

                    const chatId = isSupergroup
                        ? String(msg.chatId).slice(4)
                        : msg.chatId;

                    replyText +=
                        ">" +
                        `\\>\`${msg.userName}:${shortMsg}\`` +
                        (isSupergroup
                            ? `[前往](https://t.me/c/${chatId}/${msg.messageId})`
                            : "");

                    if (index < originalMessages.length - 1) {
                        replyText += "\n";
                    }
                });

                replyText += "||";

                await ctx.reply(replyText, {
                    parse_mode: "MarkdownV2",
                });
            } else {
                ctx.reply("没有找到上下文");
            }
        } catch (error) {
            console.error(error);
            ctx.reply(error instanceof Error ? error.message : "Unknown error");
        }
    });
};
