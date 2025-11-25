import OpenAI from "openai";
import { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources";
import { Content, GoogleGenerativeAI, Tool } from "@google/generative-ai";
import { safetySettings } from './constants';
import { getCurrentModel } from '../state';

const openai = new OpenAI({
    baseURL: process.env.OPENAI_API_URL,
    apiKey: process.env.OPENAI_API_KEY,
})


const deepseekBaseURL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1'
const deepseek = process.env.DEEPSEEK_API_KEY ? (new OpenAI({
    baseURL: deepseekBaseURL,
    apiKey: process.env.DEEPSEEK_API_KEY,
})) : openai;

export const grokAgent = new OpenAI({
    baseURL: process.env.GROK_API_URL,
    apiKey: process.env.GROK_API_KEY,
})

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : undefined;

export type ChatContentPart = Exclude<ChatCompletionContentPart, { type: 'input_audio' | 'file' }>

interface UserMessageContent {
    role: 'user'
    content: Array<ChatContentPart>
}

interface AssistantMessageContent {
    role: 'assistant'
    content: string
}

export type MessageContent = UserMessageContent | AssistantMessageContent

export const sendMsgToOpenAI = async (contents: Array<MessageContent>) => {
    const currentModel = getCurrentModel();
    console.log('模型信息: ', currentModel);
    if (currentModel.startsWith('gemini') && genAI) {
        console.log('使用谷歌 SDK');
        const model = genAI.getGenerativeModel({
            model: currentModel,
            safetySettings,
            systemInstruction: process.env.SYSTEM_PROMPT,
            tools: [
                {
                    ["google_search" as keyof Tool]: {}
                }
            ]
        });

        const geminiContent: Content[] = contents.map(({ role, content }) => {
            if (role === 'user') {
                return {
                    role,
                    parts: content.map((part) => {
                        if (part.type === 'text') {
                            return {
                                text: part.text
                            }
                        } else {
                            return {
                                inlineData: {
                                    mimeType: 'image/png',
                                    data: part.image_url.url.slice(22)
                                }
                            }
                        }
                    })
                }
            } else {
                return {
                    role: 'model',
                    parts: [{ text: content }]
                }
            }
        })

        return model.generateContentStream({
            contents: geminiContent
        });
    } else {
        console.log('使用 OpenAI SDK');

        const isO1 = currentModel.startsWith('o1');
        const extraContents: Array<ChatCompletionMessageParam> = isO1 ? [] : [
            {
                role: 'system',
                content: process.env.SYSTEM_PROMPT
            },
        ]
        isO1 && console.log('当前为 o1, 不支持系统提示词');

        const isDeepseek = currentModel.startsWith('deepseek');
        const isGrok = currentModel.startsWith('grok-');

        let platform: OpenAI;
        if (isDeepseek) {
            platform = deepseek;
        } else if (isGrok) {
            platform = grokAgent;
        } else {
            platform = openai;
        }

        isDeepseek && console.log('当前为 deepseek, 使用 ' + deepseekBaseURL);

        const res = await platform.chat.completions.create(
            {
                model: currentModel,
                messages: [
                    ...extraContents,
                    ...contents,
                ],
                stream: !isO1,
            },
        );
        return res;
    }
}