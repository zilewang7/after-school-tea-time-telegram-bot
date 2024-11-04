import OpenAI from "openai";
import dotenv from 'dotenv'
import { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Content, DynamicRetrievalMode, GoogleGenerativeAI } from "@google/generative-ai";
import { safetySettings } from './constants';

dotenv.config();

const openai = new OpenAI({
    baseURL: process.env.OPENAI_API_URL,
    apiKey: process.env.OPENAI_API_KEY,
})


const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : undefined;

interface UserMessageContent {
    role: 'user'
    content: Array<ChatCompletionContentPart>
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
              {
                googleSearchRetrieval: {
                  dynamicRetrievalConfig: {
                    mode: DynamicRetrievalMode.MODE_DYNAMIC,
                    dynamicThreshold: 0.65,
                  },
                },
              },
            ],
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

        const res = await openai.chat.completions.create(
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