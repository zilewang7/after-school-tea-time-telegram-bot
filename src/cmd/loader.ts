import { Bot } from "grammy";
import { Menus } from "./menu";
import {
    registerStartCommand,
    registerHelpCommand,
    registerReactCommand,
    registerPicCommands,
    registerModelCommand,
    registerContextCommand,
} from "./commands";

export const cmdLoad = async (bot: Bot, menus: Menus) => {
    bot.api.setMyCommands([
        { command: "start", description: "开始" },
        { command: "help", description: "没有帮助" },
        { command: "react", description: "给消息添加表情" },
        { command: "pic", description: "使用英文提示词生成图片-快速" },
        { command: "pic1", description: "使用英文提示词生成图片-均衡" },
        { command: "pic2", description: "使用英文提示词生成图片-粗糙" },
        { command: "pic3", description: "使用英文提示词生成图片-推荐" },
        { command: "picgrok", description: "使用 Grok 模型根据提示词生成图片" },
        { command: "model", description: "查看/切换大语言模型" },
        {
            command: "chat",
            description:
                "为消息添加上下文关联再进行对话，回复消息时输入 /chat [数量] [筛选条件]",
        },
        { command: "context", description: "查看当前上下文结构" },
    ]);

    registerStartCommand(bot);
    registerHelpCommand(bot);
    registerReactCommand(bot);
    registerPicCommands(bot);
    registerModelCommand(bot, menus);
    registerContextCommand(bot);
};
