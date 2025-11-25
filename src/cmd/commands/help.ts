import { Bot } from "grammy";

export const registerHelpCommand = (bot: Bot) => {
    bot.command("help", (ctx) =>
        ctx.reply(
            `在与 bot 对话之前，有必要理解一下前提：
    1. bot 的回复都是基于消息会话的上下文
    2. 没有回复 bot 而是直接发送的消息是一个新的会话，上下文中只有你发送的这条消息
    3. 消息的回复会自动加入上下文，可以点击首个消息的查看回复的 tg 自带功能查看消息树（不包含 /chat 命令的上下文）
    4. 如果想要查看某条消息确切的上下文回复 /context 命令
    5. 你可以通过带上 @${process.env.BOT_USER_NAME} 回复非 bot 消息以以此调消息所属的上下文进行对话
    6. 如果你想要把连续多条没有回复关系的消息作为上下文开始对话请使用 /chat 命令

常规使用场景：
    1. 直接 @${process.env.BOT_USER_NAME} 向 bot 提问
    2. 回复别人消息时加上 @${process.env.BOT_USER_NAME} 来帮他提问
    3. 直接回复 bot 消息以在相关消息上下文中对话
`
        )
    );
};
