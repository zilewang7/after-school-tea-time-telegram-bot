import { Bot } from "grammy";
import type { BotCommand } from "grammy/types";
import { isTestInstance, getAllowedChatIds } from "../config/instance.js";
import {
    registerStartCommand,
    registerHelpCommand,
    registerReactCommand,
    registerPicCommands,
    registerModelCommand,
    registerContextCommand,
} from "./commands/index.js";

const COMMANDS: BotCommand[] = [
    { command: "start", description: "开始" },
    { command: "help", description: "没有帮助" },
    { command: "react", description: "给消息添加表情" },
    { command: "pic", description: "生图：直接给提示词是文生图，回复一张图则是图生图" },
    { command: "picunsafe", description: "[图片不带遮罩]同 /pic" },
    { command: "vid", description: "生成视频：说个想法，Grok 写分镜，H3 出片（回复图片则作参考）" },
    { command: "vidunsafe", description: "[视频不带遮罩]同 /vid" },
    { command: "picgrok", description: "使用 Grok 模型根据提示词生成图片" },
    { command: "picbanana", description: "使用 🍌 Gemini Nano Banana Pro 根据提示词生成图片(支持图生图)" },
    { command: "picgpt", description: "使用 OpenAI gpt-image-2 根据提示词生成图片(支持图生图)" },
    { command: "model", description: "查看/切换大语言模型" },
    {
        command: "chat",
        description:
            "为消息添加上下文关联再进行对话：回复消息时输入 /chat [数量|a|r] [筛选条件]，或 /chat <消息链接> 拼接另一段对话",
    },
    { command: "context", description: "查看当前上下文结构" },
];

export const cmdLoad = async (bot: Bot) => {
    if (isTestInstance()) {
        // Register only inside the allowed test chats: members of shared
        // groups never see the test bot's commands when they type "/"
        for (const chatId of getAllowedChatIds() ?? []) {
            bot.api.setMyCommands(COMMANDS, {
                scope: { type: 'chat', chat_id: chatId },
            });
        }
    } else {
        bot.api.setMyCommands(COMMANDS);
    }

    registerStartCommand(bot);
    registerHelpCommand(bot);
    registerReactCommand(bot);
    registerPicCommands(bot);
    registerModelCommand(bot);
    registerContextCommand(bot);
};
