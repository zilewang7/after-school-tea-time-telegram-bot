import 'dotenv/config';
import { Bot } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import { cmdLoad } from './cmd/index.js';
import { replyLoad } from './reply/index.js';
import { autoClear, autoSave, autoUpdate, startEditMonitor } from './db/autoSave.js';
import { menuLoad } from './cmd/menu.js';
import { getAppState } from './state.js';
import { initMcpClients } from './ai/mcp/index.js';

if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN must be provided');
}

const proxyUrl = process.env.BOT_PROXY;

const botConfig = proxyUrl 
  ? {
      client: {
        baseFetchConfig: {
          agent: new SocksProxyAgent(proxyUrl),
          compress: true,
        },
      },
    }
  : undefined;

// initialize app state
const appState = getAppState();
console.log(`Initial model: ${appState.currentModel}`);

const bot = new Bot(process.env.BOT_TOKEN, botConfig);

// 保存消息
autoSave(bot);
// 更新编辑的消息
autoUpdate(bot);
// 自动清除一周前的消息
autoClear();
// 监测用户编辑消息，为 bot 消息添加重试按钮
startEditMonitor(bot);



// 加载菜单
menuLoad(bot);
// 使用命令
cmdLoad(bot);
// 使用回复
replyLoad(bot);

// catch error
bot.catch((error) => {
    console.log(error)
})

// Last-resort guards: never let a single detached async error crash the bot process.
process.on('unhandledRejection', (reason) => {
    console.error('[process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[process] Uncaught exception:', error);
});

// 设置简介
bot.api.setMyShortDescription("A large language model chatbot optimized for group chat\nhttps://github.com/zilewang7/after-school-tea-time-telegram-bot");
bot.api.setMyShortDescription("为群组内聊天优化的大语言模型聊天机器人\nhttps://github.com/zilewang7/after-school-tea-time-telegram-bot", {
    language_code: "zh"
});
bot.api.setMyDescription("Directly send a message to start a context conversation, reply to the bot's message to continue in the current context conversation");
bot.api.setMyDescription("直接发送消息以开启一个上下文会话，回复机器人的消息以继续在当前上下文会话, /help 以查看更多帮助", {
    language_code: "zh"
});

// 启动
async function main() {
    await initMcpClients();
    console.log('[mcp] Initialization complete');
    bot.start()
        .then(() => console.log('Bot started'))
        .catch(console.error);
}

main().catch(console.error);