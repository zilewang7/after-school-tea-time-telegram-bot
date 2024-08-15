import dotenv from 'dotenv'
import { Message as DBMessage } from "./db/messageDTO";
import { getMessage } from './db';
import { Op } from '@sequelize/core';
import { ReactionTypeEmoji } from 'grammy/types';
import { Bot, Context } from 'grammy';
import { Menu } from '@grammyjs/menu';

dotenv.config();

export const getBlob = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    return await res.blob();
}

export function matchFirstEmoji(message: string | undefined): ReactionTypeEmoji['emoji'] | null {
    if (!message) return null;
    const regex = /👍|👎|❤|🔥|🥰|👏|😁|🤔|🤯|😱|🤬|😢|🎉|🤩|🤮|💩|🙏|👌|🕊|🤡|🥱|🥴|😍|🐳|❤‍🔥|🌚|🌭|💯|🤣|⚡|🍌|🏆|💔|🤨|😐|🍓|🍾|💋|🖕|😈|😴|😭|🤓|👻|👨‍💻|👀|🎃|🙈|😇|😨|🤝|✍|🤗|🫡|🎅|🎄|☃|💅|🤪|🗿|🆒|💘|🙉|🦄|😘|💊|🙊|😎|👾|🤷‍♂|🤷|🤷‍♀|😡/;
    const match = message.match(regex);
    return match ? (match[0] as ReactionTypeEmoji['emoji']) : null;
}

export function removeSpecificText(message: string, textToRemove?: string) {
    const regex = new RegExp(`${textToRemove ? textToRemove + '|' : ''}@${process.env.BOT_USER_NAME}`, 'g');
    const cleanedMessage = message.replace(regex, '');
    return cleanedMessage;
}


export function checkIfMentioned(ctx: Context) {
    const text = ctx.message?.text || ctx.message?.caption;

    const replyUserId = ctx.message?.reply_to_message?.from?.id;

    return text?.includes(`@${process.env.BOT_USER_NAME}`) || replyUserId === Number(process.env.BOT_USER_ID) || ctx?.chat?.type === 'private';
}

export async function convertBlobToBase64(blob: Blob): Promise<string> {
    const buffer = Buffer.from(await blob.arrayBuffer())

    const base64 = buffer.toString('base64')

    // a URL of the image or the base64 encoded image data
    return `data:image/png;base64,${base64}`
}

export const getRepliesHistory = async (
    chatId: number,
    messageId: number,
    options: { withoutLast?: boolean, needRecentContext?: boolean } = {}
): Promise<DBMessage[]> => {
    const { withoutLast = true, needRecentContext = false } = options || {};

    const getRecentMessages = async (messageId: number) => {
        const messages = await DBMessage.findAll({
            where: { chatId, messageId: { [Op.lt]: messageId } },
            order: [['messageId', 'DESC']],
            limit: 50
        });

        return messages;
    }

    let messageList: DBMessage[] = [];

    if (needRecentContext) {
        const messages = await getRecentMessages(messageId);
        messageList = messages;
    }



    let headerMessageTemp: DBMessage;
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
    if (headerMsg.text && checkIfNeedRecentContext(headerMsg.text)) {
        const recentMessages = await getRecentMessages(headerMsg.messageId);
        messageList.push(...recentMessages);
    }

    const searchAllReplies = async (message: DBMessage) => {
        const repliesIds = JSON.parse(message.replies);

        if (!repliesIds.length) {
            return;
        }

        for (const replyId of repliesIds) {
            try {
                const msg = await getMessage(chatId, replyId);
                if (msg) {
                    messageList.push(msg);
                    if (msg.text && checkIfNeedRecentContext(msg.text)) {
                        const recentMessages = await getRecentMessages(msg.messageId);
                        messageList.push(...recentMessages);
                    }
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
        if (!acc.find(obj => obj.messageId === curr.messageId)) {
            acc.push(curr);
        }
        return acc;
    }, [] as DBMessage[]);
    // 排序
    messageList.sort((a, b) => a.messageId - b.messageId);

    if (withoutLast) {
        messageList.pop();
    }

    return messageList
}

export const checkIfNeedRecentContext = (text: string) => {
    const regex = new RegExp(`/^(上面|@${process.env.BOT_USER_NAME}: 上面|.*: 上面|.*: @${process.env.BOT_USER_NAME}: 上面)/`, 'g');
    return regex.test(text)
}

export const sendModelMsg = async (ctx: Context, checkModelMenu: Menu<Context>) => {
    const menu = checkModelMenu;
    await ctx.reply(
        '当前模型：' + global.currentModel + '\n\n点击下方按钮快速切换或使用 `/model [模型名]` 手动指定',
        { reply_markup: menu, parse_mode: 'Markdown' }
    );
}

export const changeModel = async (ctx: Context, model: string, checkModelMenu: Menu<Context>) => {
    global.currentModel = model;
    await sendModelMsg(ctx, checkModelMenu);
}