import 'dotenv/config';
import { Bot } from "grammy";
import { cmdLoad } from './cmd';
import { replyLoad } from './reply';
import { autoClear, autoSave } from './db/autoSave';
import { menuLoad } from './cmd/menu';
import { getAppState } from './state';

if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN must be provided');
}

// initialize app state
const appState = getAppState();
console.log(`Initial model: ${appState.currentModel}`);

const bot = new Bot(process.env.BOT_TOKEN);

// 保存消息
autoSave(bot);
// 自动清除一周前的消息
autoClear();



// 加载菜单
const menus = menuLoad(bot);
// 使用命令
cmdLoad(bot, menus);
// 使用回复
replyLoad(bot, menus);

// catch error
bot.catch((error) => {
    console.log(error)
})

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
bot.start()