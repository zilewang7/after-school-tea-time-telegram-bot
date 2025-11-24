import { ChatCompletionContentPart } from "openai/resources";
import { getMessage } from "../db";
import { MessageContent, ChatContentPart } from '../openai';
import { Message } from "../db/messageDTO";
import { getFileContentsOfMessage, getRepliesHistory } from "./helper";

export const generalContext = async (msg: Message): Promise<Array<MessageContent>> => {
    const { chatId, messageId, userName, text, quoteText, file, replyToId } = msg;

    /** 上下文汇总 */
    let chatContents: Array<MessageContent> = []


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

            const replyContent: Array<ChatContentPart> = [
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
            let text = '([system]replying to '
            const { text: msgText, userName } = (await getMessage(chatId, replyToId)) || {}

            if (msgText) {
                text += `[${userName}:`;
                // use Array.from to slice by unicode codepoints (avoid breaking emoji)
                const msgChars = Array.from(msgText);
                text += `${msgChars.length > 20 ? (msgChars.slice(0, 20).join('') + '...') : msgChars.join('')}]`
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

    const msgContent: Array<ChatContentPart> = [
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

    // deepseek-r1 does not support successive user or assistant messages (messages[1] and messages[2] in your input). You should interleave the user/assistant messages in the message sequence.
    // 将连续的消息合并成一条
    if (global.currentModel === 'deepseek-reasoner') {
        const newChatContents: Array<MessageContent> = [];
        let currentRole: 'user' | 'assistant' = 'user';
        // 目前只有用户消息进行合并
        let lastContent: Array<ChatContentPart> = [];
        // bot 的消息无法使用数组存放，将消息简单合并
        let assistantContent: string = '';

        const updateContent = () => {
            if (lastContent.length > 0 || assistantContent.length > 0) {
                if (currentRole === 'user') {
                    newChatContents.push({
                        role: 'user',
                        content: lastContent
                    })
                    lastContent = [];
                } else if (currentRole === 'assistant') {
                    newChatContents.push({
                        role: 'assistant',
                        content: assistantContent
                    })
                    assistantContent = '';
                }
            }
        }

        const saveTempContent = (content: MessageContent) => {
            if (content.role === 'user') {
                lastContent = lastContent.concat(content.content);
            } else if (content.role === 'assistant') {
                if (assistantContent.length) {
                    assistantContent += '\n\n\n';
                }
                assistantContent += content.content;
            }
        }

        for (const content of chatContents) {
            if (!(currentRole === content.role)) {
                updateContent();
                currentRole = content.role;
            }
            saveTempContent(content);
        }

        updateContent();

        chatContents = newChatContents;
    }

    // 不支持图片的模型需要过滤图片
    if (global.currentModel.startsWith('deepseek-') || global.currentModel.startsWith('o1-')) {
        chatContents = chatContents.map(content => {
            if (content.role === 'user') {
                return {
                    role: 'user',
                    content: content.content.filter(part => part.type === 'text')
                }
            } else {
                return content;
            }
        })
    }

    return chatContents;
}