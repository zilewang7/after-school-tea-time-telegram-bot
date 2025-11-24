import { Context, InputFile } from "grammy";
import { grokAgent } from ".";

export const generateImageByPrompt = async (ctx: Context, model: string, msg: string) => {
    try {
        if (!ctx.match) {
            await ctx.reply("No input found");
            return;
        }


        if (model === 'grok') {
            const response = await grokAgent.images.generate({
                model: "grok-2-image-1212",
                prompt: msg,
            });

            if (!response.data?.[0]?.url) {
                throw new Error("No image URL found in response");
            }

            await ctx.replyWithPhoto(response.data[0].url);

            return;
        }

        const res = await fetch("https://sd-cf.nloli.xyz/pic?key=114514", {
            headers: {
                accept: "*/*",
                "accept-language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
                "content-type": "application/json",
                "sec-ch-ua": "\"Google Chrome\";v=\"123\", \"Not:A-Brand\";v=\"8\", \"Chromium\";v=\"123\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-site",
                Referer: "https://lab.nloli.xyz/",
                "Referrer-Policy": "strict-origin-when-cross-origin",
            },
            body: JSON.stringify({ model, prompt: msg }),
            method: "POST",
        });

        if (model === '3') {
            const json = await res.json() as { image: string };

            const buffer = Buffer.from(json.image, 'base64') as any;

            await ctx.replyWithPhoto(new InputFile(buffer));
        } else {
            const buffer = Buffer.from(await res.arrayBuffer()) as any;

            await ctx.replyWithPhoto(new InputFile(buffer));
        }
    } catch (error) {
        console.error('Error fetching and sending photo:', error);
        ctx.reply('无法获取图片，请稍后再试。');
    }
};