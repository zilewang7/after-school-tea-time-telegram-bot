import dotenv from 'dotenv'
import { Bot } from "grammy";
import { cmdLoad } from './cmd';
import { replyLoad } from './reply';
import { autoClear, autoSave } from './db/autoSave';

dotenv.config();


if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN must be provided')
}

global.currentModel = process.env.DEFAULT_MODEL || "gpt-4o-2024-08-06";

// 波特实例
const bot = new Bot(process.env.BOT_TOKEN)


Object.assign(global, { mediaGroupIdTemp: {}, asynchronousFileSaveMsgIdList: [] });

// 保存消息
autoSave(bot);
// 自动清除一周前的消息
autoClear();



// 使用命令
cmdLoad(bot);
// 使用回复
replyLoad(bot);


// 启动
bot.start()