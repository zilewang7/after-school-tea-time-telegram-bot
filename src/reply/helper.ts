import { Op } from '@sequelize/core';
import { Context } from "grammy";
import { ChatCompletionContentPartImage } from "openai/resources";
import { Message } from "../db/messageDTO";
import { getMessage } from '../db';

export const getRepliesHistory = async (
    chatId: number,
    messageId: number,
    options: { excludeSelf?: boolean } = {}
): Promise<Message[]> => {
    const { excludeSelf } = options || {};

    let messageList: Message[] = [];

    let headerMessageTemp: Message;
    const findHeaderMsg = async (messageId: number) => {
        const msg = await getMessage(chatId, messageId);

        if (msg?.replyToId) {
            headerMessageTemp = msg;
            return await findHeaderMsg(msg?.replyToId);
        } else {
            return msg ? msg : headerMessageTemp;
        }
    }

    const headerMsg = await findHeaderMsg(messageId);

    if (!headerMsg) {
        return [];
    }

    messageList.push(headerMsg);

    const searchAllReplies = async (message: Message) => {
        const repliesIds = JSON.parse(message.replies);

        if (!repliesIds.length) {
            return;
        }

        for (const replyId of repliesIds) {
            try {
                const msg = await getMessage(chatId, replyId);
                if (msg) {
                    messageList.push(msg);
                    await searchAllReplies(msg);
                }
            } catch (error) {
                console.error(error);
            }
        }
    }
    await searchAllReplies(headerMsg);

    // 去重
    messageList = messageList.reduce((acc, curr) => {
        if (
            !acc.find(obj => obj.messageId === curr.messageId) &&
            (!excludeSelf || curr.messageId !== messageId) &&
            !(curr.text && /sub image of \[(\w+)\]/.test(curr.text))
        ) {
            acc.push(curr);
        }
        return acc;
    }, [] as Message[]);
    // 排序
    messageList.sort((a, b) => a.messageId - b.messageId);

    return messageList
}

export const getFileContentsOfMessage = async (chatId: number, messageId: number): Promise<ChatCompletionContentPartImage[]> => {
    const message = await getMessage(chatId, messageId);
    if (!message || !(message.file || JSON.parse(message.replies)?.length)) {
        return [];
    }

    const fileList = message.file ? [message.file] : [];
    const repliesIds = JSON.parse(message.replies);

    for (const replyId of repliesIds) {
        const msg = await getMessage(chatId, replyId);
        if (msg?.file && msg?.text?.match(/sub image of \[(\w+)\]/)?.[1] === String(messageId)) {
            fileList.push(msg.file);
        }
    }

    return fileList.map(file => ({
        type: 'image_url',
        image_url: {
            url: `data:image/png;base64,${file.toString('base64')}`
        }
    }))
}

export const dealChatCommand = async (ctx: Context) => {
    if (!ctx.message || !ctx.chat || !ctx.message.text?.startsWith('/chat')) { return; }

    const text = ctx.message.text;
    const messageId = ctx.message.reply_to_message?.message_id;
    const chatId = ctx.chat.id;
    const firstName = ctx.message.reply_to_message?.from?.first_name || '';


    const regex = /^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/;

    const [, count, , optional = 'Infinity'] = text.match(regex) || [];

    if (!messageId || text === `/chat@${process.env.BOT_USER_NAME}` || text === '/chat' || !count) {
        ctx.reply(
            `\`/chat\` 仅在需要添加上下文时使用，如无此需求请直接回复或者 @${process.env.BOT_USER_NAME} 发送消息

用法:
在回复消息时添加参数, 最后可以加上你要告诉 ai 的内容
\`/chat [数字|a]\` 将被回复的消息及后面的\`[数字]\`条消息的上下文添加到会话中，如果是 a 则将后面的所有消息都添加到会话中
\`/chat [数字|a]\` -[可选参数] 第二个参数为可选参数，筛选后不会影响要添加的消息条数
    \`s\`(single) 仅被回复的人的消息
    \`[数字]\` 加到上下文的用户人数，从被回复的人往下查找递增
    \`[firstName]\` 除被回复人外还要加到上下文的用户的前半部分名字，如果有多个用 \`/\` 分隔

用例:
\`/chat 5 他们在说什么\` 将被回复的消息及后面的 4 条消息添加到上下文中
\`/chat 3 -s 解答一下\` 将被回复的人的消息及他后面的 2 条消息添加到上下文中
\`/chat 8 -3 他们三个人是什么关系\` 将被回复的消息以及后面出现的总共最多 3 人的共 8 条消息的添加到上下文中
\`/chat 5 -李四/王五 张三是不是大哥\` 将被回复人以及李四、王五的消息共计5条消息添加到上下文中
\`/chat a -s 总结一下他说的\` 将被回复消息的回复人的下面所有消息添加到上下文中`,
            {
                parse_mode: 'Markdown'
            }
        );

        return false;
    }

    const msgCount = count === 'a' ? Infinity : Number(count);
    let userCount: number;
    let userList: string[] | undefined;

    if (/^\d+$/.test(optional)) {
        userCount = Number(optional)
    } else if (optional === 's') {
        userCount = 1
    } else if (optional === 'Infinity') {
        userCount = Infinity
    } else {
        userCount = Infinity
        userList = [...new Set([...optional.split('/'), firstName])]
    }

    // 查询逻辑
    let queryConditions: any = {
        chatId,
        messageId: { [Op.gte]: messageId }, // 选择大于等于 messageId 的消息
    };

    if (userList) {
        queryConditions.userName = { [Op.in]: userList }; // 仅查询特定用户
    } else if (userCount === 1) {
        queryConditions.userName = ctx.message.from.first_name; // 仅查询被回复人
    }

    // 执行查询，获取上下文消息
    const messages = await Message.findAll({
        where: queryConditions,
        order: [['messageId', 'ASC']], // 按 messageId 升序排列
        limit: msgCount === Infinity ? undefined : msgCount,
    });

    let finalMassageIds: number[] = [];
    // 处理用户计数的情况
    if (userCount !== Infinity) {
        const userMap = new Set<string>();
        messages.forEach(({ userName, messageId }) => {
            if (!userMap.has(userName) && userMap.size <= userCount) {
                userMap.add(userName);
                finalMassageIds.push(messageId);
            } else if (userMap.has(userName)) {
                finalMassageIds.push(messageId);
            }
        })
    } else {
        finalMassageIds = messages.map(({ messageId }) => messageId);
    }

    finalMassageIds = finalMassageIds.filter(id => id !== messageId);

    if (finalMassageIds.length > 50) {
        ctx.reply(`共查询到 ${finalMassageIds.length} 条消息，超出50条，太多了！`);
    } else {
        await Message.findOne({ where: { chatId, messageId } }).then((msg) => {
            if (msg) {
                const replies = new Set([JSON.parse(msg.replies), finalMassageIds].flat());
                msg.replies = JSON.stringify(Array.from(replies));
                msg.save();
            }
        });

        return true;
    }
}

// 处理 /picbanana 命令（不通过 bot.command 注册，自己识别）
export const dealPicbananaCommand = async (ctx: Context): Promise<{ prompt: string; referenceImages: string[] } | null> => {
    if (!ctx.message || !ctx.chat) { return null; }

    // 获取文本或 caption
    const text = ctx.message.text || ('caption' in ctx.message ? ctx.message.caption : undefined);
    if (!text) { return null; }

    // 检查是否是 /picbanana 命令
    const commandRegex = /^\/picbanana(@\S+)?\s*([\s\S]*)?$/;
    const match = text.match(commandRegex);

    if (!match) { return null; }

    const prompt = match[2]?.trim() || '';

    if (!prompt) {
        await ctx.reply('请提供图片描述');
        throw new Error("[picbanana] User did not provide prompt")
    }

    const referenceImages = new Set<string>();
    const chatId = ctx.chat.id;
    const currentMessageId = ctx.message.message_id;

    const appendImagesFromMessage = async (targetChatId: number, targetMessageId: number) => {
        const images = await getFileContentsOfMessage(targetChatId, targetMessageId);
        images.forEach(({ image_url }) => {
            const url = image_url.url;
            const base64 = url.includes(',') ? url.split(',')[1] : url;
            if (base64) {
                referenceImages.add(base64);
            }
        });
    };

    await appendImagesFromMessage(chatId, currentMessageId);

    // 检查是否有回复的图片作为参考
    if (ctx.message.reply_to_message) {
        const replyMsg = ctx.message.reply_to_message;

        await appendImagesFromMessage(chatId, replyMsg.message_id);

        if (referenceImages.size === 0) {
            let fileId: string | undefined;

            if ('photo' in replyMsg && replyMsg.photo && replyMsg.photo.length > 0) {
                fileId = replyMsg.photo[replyMsg.photo.length - 1]?.file_id;
            } else if ('document' in replyMsg && replyMsg.document?.mime_type?.startsWith('image/')) {
                fileId = replyMsg.document.file_id;
            }

            if (fileId) {
                try {
                    const file = await ctx.api.getFile(fileId);
                    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
                    const response = await fetch(fileUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    referenceImages.add(Buffer.from(arrayBuffer).toString('base64'));
                } catch (error) {
                    console.error('Failed to fetch reference image from reply:', error);
                }
            }
        }
    }

    if (ctx.message.media_group_id) {
        for (let i = 0; i < 3; i++) {
            const previousSize = referenceImages.size;
            await new Promise(resolve => setTimeout(resolve, 200));
            await appendImagesFromMessage(chatId, currentMessageId);
            if (referenceImages.size === previousSize) {
                break;
            }
        }
    }

    // 消息中的图片（兜底，避免数据库未就绪）
    if (referenceImages.size === 0 && 'photo' in ctx.message && ctx.message.photo && ctx.message.photo.length > 0) {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1]?.file_id;
        if (fileId) {
            try {
                const file = await ctx.api.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
                const response = await fetch(fileUrl);
                const arrayBuffer = await response.arrayBuffer();
                referenceImages.add(Buffer.from(arrayBuffer).toString('base64'));
            } catch (error) {
                console.error('Failed to fetch reference image:', error);
            }
        }
    }

    return { prompt, referenceImages: Array.from(referenceImages) };
}
