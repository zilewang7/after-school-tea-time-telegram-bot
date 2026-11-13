import type { Bot } from "grammy";
import type { BotCommand } from "grammy/types";
import { isTestInstance, getAllowedChatIds } from "../config/instance.js";
import { OPENAI_IMAGE_MODEL } from "../config/models.js";
import { shareCommandEnabled } from "../config/share-command.js";
import {
    registerStartCommand,
    registerHelpCommand,
    registerReactCommand,
    registerPicCommands,
    registerModelCommand,
    registerContextCommand,
    registerPanelCommand,
    registerApplyCommand,
    registerWidgetCommands,
    registerWebCommand,
    registerShareCommand,
    registerPricingCommand,
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
    { command: "picbanana", description: "使用 🍌 Gemini Nano Banana 2.1 根据提示词生成图片(支持图生图)" },
    { command: "picgpt", description: `使用 OpenAI ${OPENAI_IMAGE_MODEL} 根据提示词生成图片(支持图生图)` },
    { command: "model", description: "查看/切换本聊天的模型" },
    { command: "apply", description: "体验用户申请完整功能准入" },
    { command: "panel", description: "打开控制面板" },
    { command: "web", description: "获取网页版身份码（私聊）" },
    {
        command: "chat",
        description:
            "为消息添加上下文关联再进行对话：回复消息时输入 /chat [数量|a|r] [筛选条件]，或 /chat <消息链接> 拼接另一段对话",
    },
    { command: "context", description: "查看当前上下文结构" },
];

/** Offered only while the share command is enabled */
const SHARE_COMMANDS: BotCommand[] = [
    { command: "share", description: "分享会话：回复一条消息，生成公开分享链接" },
    { command: "shareone", description: "分享单条回复：回复 bot 的消息，生成公开分享链接" },
];

/** The command menu; the test instance registers this same list per chat */
const commandMenuOf = (): BotCommand[] =>
    shareCommandEnabled() ? [...COMMANDS, ...SHARE_COMMANDS] : COMMANDS;

export const cmdLoad = async (bot: Bot) => {
    const commands = commandMenuOf();
    if (isTestInstance()) {
        // Register only inside the allowed test chats: members of shared
        // groups never see the test bot's commands when they type "/"
        for (const chatId of getAllowedChatIds() ?? []) {
            bot.api.setMyCommands(commands, {
                scope: { type: 'chat', chat_id: chatId },
            });
        }
    } else {
        bot.api.setMyCommands(commands);
    }

    registerStartCommand(bot);
    registerHelpCommand(bot);
    registerReactCommand(bot);
    registerPicCommands(bot);
    registerModelCommand(bot);
    registerContextCommand(bot);
    registerPanelCommand(bot);
    registerApplyCommand(bot);
    registerWebCommand(bot);
    // Always registered so a disabled command answers OFF_TEXT instead of
    // falling through to the AI reply path; only the menu entry is gated.
    registerShareCommand(bot);
    // Owner-only, hidden from the command menu: widget readiness and probe
    registerWidgetCommands(bot);
    // Owner-only, hidden from the command menu: run the price watcher by hand
    registerPricingCommand(bot);
};
