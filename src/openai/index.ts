import OpenAI from "openai";
import dotenv from 'dotenv'
import { ChatCompletionContentPart } from "openai/resources/index.mjs";
import { Content, GoogleGenerativeAI } from "@google/generative-ai";
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
    if (global.currentModel.startsWith('gemini') && genAI) {
        const model = genAI.getGenerativeModel({
            model: global.currentModel,
            safetySettings,
            systemInstruction: process.env.SYSTEM_PROMPT
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
                                    mimeType: 'image/jpeg',
                                    data: part.image_url.url
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
        const res = await openai.chat.completions.create(
            {
                model: global.currentModel,
                messages: [
                    {
                        role: 'system',
                        content: process.env.SYSTEM_PROMPT
                    },
                    ...contents,
                ],
                stream: true,
            },
        );
        return res;
    }
}