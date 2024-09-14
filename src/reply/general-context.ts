import { ChatCompletionContentPart } from "openai/resources/index.mjs";
import { getMessage } from "../db";
import { MessageContent } from '../openai/index';
import { Message } from "../db/messageDTO";
import { getFileContentsOfMessage, getRepliesHistory } from "./helper";

export const generalContext = async (msg: Message): Promise<Array<MessageContent>> => {
    const { chatId, messageId, userName, text, quoteText, file, replyToId } = msg;

    const chatContents: Array<MessageContent> = []

    const historyReplies = await getRepliesHistory(chatId, messageId, { excludeSelf: true });
    for (const repledMsg of historyReplies) {
        if (repledMsg?.fromBotSelf) {
            chatContents.push({
                role: 'assistant',
                content: repledMsg.text || '[system] message lost',
            })
        } else {
            const msgContent = {
                type: 'text' as const,
                text: `${repledMsg.userName}: `
                    + (repledMsg?.text || '')
            }

            const fildContents = repledMsg.file ?
                await getFileContentsOfMessage(repledMsg.chatId, repledMsg.messageId)
                : [];

            const replyContent: Array<ChatCompletionContentPart> = [
                ...fildContents,
                msgContent
            ];

            chatContents.push({
                role: 'user',
                content: replyContent
            })
        }
    }

    // 当前消息
    const msgContent: Array<ChatCompletionContentPart> = []

    const replyText = await (async () => {
        if (replyToId) {
            let text = '([system]repling to '
            const msgText = (await getMessage(chatId, replyToId))?.text

            if (msgText) {
                text += `[${msgText.length > 20 ? (msgText.slice(0, 20) + '...') : msgText}]`
            } else {
                text += '[last message]'
            }

            if (quoteText) {
                text += `[quote: ${quoteText}]`
            }

            text += '): '
            return text;
        } else {
            return ': ';
        }
    })()

    msgContent.push({
        type: 'text' as const,
        text: `${userName}`
            + replyText
            + (text || '')
    })

    const fildContents = file ?
        await getFileContentsOfMessage(chatId, messageId)
        : [];

    msgContent.push(...fildContents);


    chatContents.push({
        role: 'user' as const,
        content: msgContent
    })

    return chatContents;
}