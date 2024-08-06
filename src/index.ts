import dotenv from 'dotenv'
import { Bot } from "grammy";
import { cmdLoad } from './cmd';
import { replyLoad } from './reply';
import { autoClear, autoSave } from './db/autoSave';

dotenv.config();


if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN must be provided')
}

// 波特实例
const bot = new Bot(process.env.BOT_TOKEN)


declare global {
    // 文件组标识
    var mediaGroupIdTemp: {
        chatId: number;
        messageId: number;
        mediaGroupId: string;
    };
    // 正在保存中的文件 id
    var asynchronousFileSaveMsgIdList: number[];
}

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