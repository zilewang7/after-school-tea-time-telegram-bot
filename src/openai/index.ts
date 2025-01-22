import OpenAI from "openai";
import dotenv from 'dotenv'
import { ChatCompletionContentPart, ChatCompletionContentPartInputAudio, ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Content, GoogleGenerativeAI, Tool } from "@google/generative-ai";
import { safetySettings } from './constants';

dotenv.config();

const openai = new OpenAI({
    baseURL: process.env.OPENAI_API_URL,
    apiKey: process.env.OPENAI_API_KEY,
})


const deepseekBaseURL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1'
const deepseek = process.env.DEEPSEEK_API_KEY ? (new OpenAI({
    baseURL: deepseekBaseURL,
    apiKey: process.env.DEEPSEEK_API_KEY,
})) : openai;


const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : undefined;

export type ChatContentPart =  Exclude<ChatCompletionContentPart, ChatCompletionContentPartInputAudio>

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
    console.log('模型信息: ', global.currentModel);
    if (global.currentModel.startsWith('gemini') && genAI) {
        console.log('使用谷歌 SDK');
        const model = genAI.getGenerativeModel({
            model: global.currentModel,
            safetySettings,
            systemInstruction: process.env.SYSTEM_PROMPT,
            tools: [
                ...(global.currentModel === 'gemini-2.0-flash-exp' ? [{
                    ["google_search" as keyof Tool]: {
                    }
                }] : []),
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

        const isO1 = global.currentModel.startsWith('o1');
        const extraContents: Array<ChatCompletionMessageParam> = isO1 ? [] : [
            {
                role: 'system',
                content: process.env.SYSTEM_PROMPT
            },
        ]
        isO1 && console.log('当前为 o1, 不支持系统提示词');

        const isDeepseek = global.currentModel.startsWith('deepseek');
        const platform = isDeepseek ? deepseek : openai;
        isDeepseek && console.log('当前为 deepseek, 使用 ' + process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1');

        const res = await platform.chat.completions.create(
            {
                model: global.currentModel,
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