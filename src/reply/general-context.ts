import { getMessage } from "../db";
import { MessageContent, ChatContentPart } from '../openai';
import { Message } from "../db/messageDTO";
import { getFileContentsOfMessage, getRepliesHistory } from "./helper";
import { getCurrentModel } from '../state';

export const generalContext = async (msg: Message): Promise<Array<MessageContent>> => {
    const { chatId, messageId, userName, text, quoteText, file, replyToId } = msg;

    /** 上下文汇总 */
    let chatContents: Array<MessageContent> = []

    // 历史消息
    const historyReplies = await getRepliesHistory(chatId, messageId, { excludeSelf: true });
    for (const repledMsg of historyReplies) {
        const modelParts = (() => {
            try {
                return repledMsg.modelParts ? JSON.parse(JSON.stringify(repledMsg.modelParts)) : undefined;
            } catch {
                return undefined;
            }
        })();

        const fildContents = repledMsg.file ?
            await getFileContentsOfMessage(repledMsg.chatId, repledMsg.messageId)
            : [];

        if (repledMsg?.fromBotSelf) {
            const assistantParts: Array<ChatContentPart> = [];
            if (fildContents.length) {
                assistantParts.push(...fildContents);
            }
            if (repledMsg.text) {
                assistantParts.push({
                    type: 'text',
                    text: repledMsg.text
                });
            }

            chatContents.push({
                role: 'assistant',
                content: assistantParts.length ? assistantParts : (repledMsg.text || '[system] message lost'),
                modelParts: modelParts && Array.isArray(modelParts) ? modelParts : undefined,
            })
        } else {
            const msgContent = {
                type: 'text' as const,
                text: `${repledMsg.userName}: `
                    + (repledMsg?.text || '')
            }

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
    // merge consecutive messages into one
    const currentModel = getCurrentModel();
    if (currentModel === 'deepseek-reasoner') {
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

    // filter images for models that don't support them
    const lowerModel = currentModel.toLowerCase();
    const supportImages = lowerModel.startsWith('gemini') || lowerModel.includes('image') || lowerModel.includes('vision') || lowerModel.includes('gpt-4o');
    if (!supportImages) {
        chatContents = chatContents.map(content => {
            if (content.role === 'user') {
                return {
                    role: 'user',
                    content: content.content.filter(part => part.type === 'text')
                }
            } else if (Array.isArray(content.content)) {
                return {
                    role: 'assistant',
                    content: content.content.filter(part => part.type === 'text'),
                    modelParts: undefined
                }
            } else {
                return content;
            }
        })
    }

    return chatContents;
}
