import { ChatCompletionContentPart } from "openai/resources/index.mjs";
import { getMessage } from "../db";
import { MessageContent } from '../openai/index';
import { Message } from "../db/messageDTO";
import { getFileContentsOfMessage, getRepliesHistory } from "./helper";

export const generalContext = async (msg: Message): Promise<Array<MessageContent>> => {
    const { chatId, messageId, userName, text, quoteText, file, replyToId } = msg;
    
    /** 上下文汇总 */ 
    const chatContents: Array<MessageContent> = []


    // 历史消息
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
    const fildContents = file ?
        await getFileContentsOfMessage(chatId, messageId)
        : [];

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

    const msgContent: Array<ChatCompletionContentPart> = [
        ...fildContents,
        {
            type: 'text' as const,
            text: userName
                + `${replyText}`
                + (text || '')
        }
    ]

    chatContents.push({
        role: 'user' as const,
        content: msgContent
    })

    return chatContents;
}