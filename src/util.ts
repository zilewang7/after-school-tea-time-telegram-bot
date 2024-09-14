import dotenv from 'dotenv'
import { Context } from 'grammy';
import { ReactionTypeEmoji, Update } from 'grammy/types';
import { Menu } from '@grammyjs/menu';
import { reply } from './reply/chat';
import { getMessage } from './db';

dotenv.config();

export const getBlob = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    return await res.blob();
}

export function matchFirstEmoji(message: string | undefined): ReactionTypeEmoji['emoji'] | null {
    if (!message) return null;
    const regex = /👍|👎|❤|🔥|🥰|👏|😁|🤔|🤯|😱|🤬|😢|🎉|🤩|🤮|💩|🙏|👌|🕊|🤡|🥱|🥴|😍|🐳|❤‍🔥|🌚|🌭|💯|🤣|⚡|🍌|🏆|💔|🤨|😐|🍓|🍾|💋|🖕|😈|😴|😭|🤓|👻|👨‍💻|👀|🎃|🙈|😇|😨|🤝|✍|🤗|🫡|🎅|🎄|☃|💅|🤪|🗿|🆒|💘|🙉|🦄|😘|💊|🙊|😎|👾|🤷‍♂|🤷|🤷‍♀|😡/;
    const match = message.match(regex);
    return match ? (match[0] as ReactionTypeEmoji['emoji']) : null;
}

export function removeSpecificText(message: string, textToRemove?: string) {
    const regex = new RegExp(`${textToRemove ? textToRemove + '|' : ''}@${process.env.BOT_USER_NAME}`, 'g');
    const cleanedMessage = message.replace(regex, '');
    return cleanedMessage;
}


export function checkIfMentioned(ctx: Context) {
    const text = ctx.message?.text || ctx.message?.caption;

    const replyUserId = ctx.message?.reply_to_message?.from?.id;

    return text?.includes(`@${process.env.BOT_USER_NAME}`) || replyUserId === Number(process.env.BOT_USER_ID) || ctx?.chat?.type === 'private';
}

export async function convertBlobToBase64(blob: Blob): Promise<string> {
    const buffer = Buffer.from(await blob.arrayBuffer())

    const base64 = buffer.toString('base64')

    // a URL of the image or the base64 encoded image data
    return `data:image/png;base64,${base64}`
}

export const sendModelMsg = async (ctx: Context, checkModelMenu: Menu<Context>) => {
    const menu = checkModelMenu;
    await ctx.reply(
        '当前模型：' + global.currentModel + '\n\n点击下方按钮快速切换或使用 `/model [模型名]` 手动指定',
        { reply_markup: menu, parse_mode: 'Markdown' }
    );
}

export const changeModel = async (ctx: Context, model: string, checkModelMenu: Menu<Context>) => {
    global.currentModel = model;
    await sendModelMsg(ctx, checkModelMenu);
}

export const retry = async (ctx: Context, retryMenu: Menu<Context>) => {
    const message = ctx.update.callback_query?.message?.reply_to_message;
    const chatId = message?.chat.id;
    const messageId = message?.message_id;

    if (!chatId || !messageId) {
        return;
    }

    const update = {
        ...ctx.update,
        ...message,
        message: message,
        reply_to_message: {
            message_id: (await getMessage(chatId, messageId))?.replyToId
        }
    } as Update

    const newCtx = new Context(update, ctx.api, ctx.me)

    reply(newCtx, retryMenu, { mention: true });
}