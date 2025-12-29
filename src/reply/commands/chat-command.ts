/**
 * /chat command handler
 * Adds additional context to messages
 */
import { Op } from '@sequelize/core';
import type { Context } from 'grammy';
import { Message } from '../../db/messageDTO';
import { findBotResponseByMessageId } from '../../db';

/**
 * Handle /chat command
 * Returns true if command was processed and bot should respond
 */
export const dealChatCommand = async (ctx: Context): Promise<boolean | undefined> => {
    if (!ctx.message || !ctx.chat || !ctx.message.text?.startsWith('/chat')) {
        return;
    }

    const text = ctx.message.text;
    const messageId = ctx.message.reply_to_message?.message_id;
    const chatId = ctx.chat.id;
    const firstName = ctx.message.reply_to_message?.from?.first_name || '';

    // Parse command: /chat [count|a] [-option] [message]
    const regex = /^\/chat\s+([0-9a]+)\s*(-(\S+))?\s*(.+)?$/;
    const matchResult = text.match(regex);
    const [, count, , optional = 'Infinity'] = matchResult || [];

    // Show help if no valid parameters
    if (
        !messageId ||
        text === `/chat@${process.env.BOT_USER_NAME}` ||
        text === '/chat' ||
        !count
    ) {
        await ctx.reply(
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
            { parse_mode: 'Markdown' }
        );
        return false;
    }

    const msgCount = count === 'a' ? Infinity : Number(count);
    let userCount: number;
    let userList: string[] | undefined;

    // Parse optional parameter
    if (/^\d+$/.test(optional)) {
        userCount = Number(optional);
    } else if (optional === 's') {
        userCount = 1;
    } else if (optional === 'Infinity') {
        userCount = Infinity;
    } else {
        userCount = Infinity;
        userList = [...new Set([...optional.split('/'), firstName])];
    }

    // Build query conditions
    const queryConditions: Record<string, any> = {
        chatId,
        messageId: { [Op.gte]: messageId },
    };

    if (userList) {
        queryConditions.userName = { [Op.in]: userList };
    } else if (userCount === 1) {
        queryConditions.userName = ctx.message.from?.first_name;
    }

    // Execute query
    const messages = (await Message.findAll({
        where: queryConditions,
        order: [['messageId', 'ASC']],
        limit: msgCount === Infinity ? undefined : msgCount,
    }))

    // Filter by user count
    let finalMessageIds: number[] = [];

    if (userCount !== Infinity) {
        const userMap = new Set<string>();
        messages.forEach(({ userName, messageId }) => {
            if (!userMap.has(userName) && userMap.size <= userCount) {
                userMap.add(userName);
                finalMessageIds.push(messageId);
            } else if (userMap.has(userName)) {
                finalMessageIds.push(messageId);
            }
        });
    } else {
        finalMessageIds = messages.map(({ messageId }) => messageId);
    }

    // Remove current message from list
    finalMessageIds = finalMessageIds.filter((id) => id !== messageId);

    // Check message count limit
    if (finalMessageIds.length > 50) {
        await ctx.reply(`共查询到 ${finalMessageIds.length} 条消息，超出50条，太多了！`);
        return false;
    }

    // Update message replies in database
    // First try Message table, then check if it's a bot continuation message
    let targetMessageId = messageId;
    let originalMsg = await Message.findOne({ where: { chatId, messageId } });

    if (!originalMsg) {
        // Check if this is a bot continuation message (not firstMessageId)
        const botResponse = await findBotResponseByMessageId(chatId, messageId);
        if (botResponse) {
            // Use the firstMessageId which is stored in Message table
            targetMessageId = botResponse.messageId;
            originalMsg = await Message.findOne({ where: { chatId, messageId: targetMessageId } });
        }
    }

    if (originalMsg) {
        const existingReplies = new Set<number>(JSON.parse(originalMsg.replies));
        finalMessageIds.forEach((id) => existingReplies.add(id));
        originalMsg.replies = JSON.stringify(Array.from(existingReplies));
        await originalMsg.save();
    }

    return true;
};
