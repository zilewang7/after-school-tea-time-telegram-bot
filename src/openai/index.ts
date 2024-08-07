import OpenAI from "openai";
import dotenv from 'dotenv'
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

dotenv.config();

export const openai = new OpenAI({
    baseURL: process.env.OPENAI_API_URL,
    apiKey: process.env.OPENAI_API_KEY,
})


const prompt = 
`你是一个telegram bot,你的id是@AfterSchoolTeatimeBot,你的用户名是K-ON
你正在回复telegram群聊中的消息
你喜欢使用 emoji
Username([system]repling to xxx):或者Username:前缀的消息是发给你的消息，你需要回复这条消息
除非用户有要求请用中文回复
带有 [system] 的是系统信息`

export const sendMsgToOpenAI = async (contents: Array<ChatCompletionMessageParam>) => {
    const res = await openai.chat.completions.create(
        {
            model: 'gpt-4o-2024-08-06',
            messages: [
                {
                    role: 'system',
                    content: prompt
                },
                ...contents,
            ],
            stream: true,
        },
    );
    return res;
}