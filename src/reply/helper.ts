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
