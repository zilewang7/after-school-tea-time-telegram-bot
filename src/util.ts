/**
 * Utility functions
 */
import { Context } from 'grammy';
import type { ReactionTypeEmoji, Update } from 'grammy/types';
import type { Menu } from '@grammyjs/menu';
import { handleReply, handlePicbananaCommand, checkPicbananaCommand } from './reply';
import { getMessage } from './db';
import { getCurrentModel, setCurrentModel } from './state';

/**
 * Fetch a URL and return as Blob
 */
export const getBlob = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    return await res.blob();
};

/**
 * Match first emoji in message text
 */
export const matchFirstEmoji = (
    message: string | undefined
): ReactionTypeEmoji['emoji'] | null => {
    if (!message) return null;

    const regex =
        /👍|👎|❤|🔥|🥰|👏|😁|🤔|🤯|😱|🤬|😢|🎉|🤩|🤮|💩|🙏|👌|🕊|🤡|🥱|🥴|😍|🐳|❤‍🔥|🌚|🌭|💯|🤣|⚡|🍌|🏆|💔|🤨|😐|🍓|🍾|💋|🖕|😈|😴|😭|🤓|👻|👨‍💻|👀|🎃|🙈|😇|😨|🤝|✍|🤗|🫡|🎅|🎄|☃|💅|🤪|🗿|🆒|💘|🙉|🦄|😘|💊|🙊|😎|👾|🤷‍♂|🤷|🤷‍♀|😡/;
    const match = message.match(regex);

    return match ? (match[0] as ReactionTypeEmoji['emoji']) : null;
};

/**
 * Remove specific text and bot mention from message
 */
export const removeSpecificText = (message: string, textToRemove?: string): string => {
    const regex = new RegExp(
        `${textToRemove ? textToRemove + '|' : ''}@${process.env.BOT_USER_NAME}`,
        'g'
    );
    return message.replace(regex, '');
};

/**
 * Check if bot was mentioned in the message
 */
export const checkIfMentioned = (
    ctx: Context,
    mention: boolean | undefined
): boolean => {
    if (mention === false) {
        return false;
    }

    const text = ctx.message?.text || ctx.message?.caption;
    const replyUserId = ctx.message?.reply_to_message?.from?.id;

    return (
        text?.includes(`@${process.env.BOT_USER_NAME}`) ||
        replyUserId === Number(process.env.BOT_USER_ID) ||
        ctx.chat?.type === 'private' ||
        Boolean(mention)
    );
};

/**
 * Convert Blob to base64 data URL
 */
export const convertBlobToBase64 = async (blob: Blob): Promise<string> => {
    const buffer = Buffer.from(await blob.arrayBuffer());
    const base64 = buffer.toString('base64');
    return `data:image/png;base64,${base64}`;
};

/**
 * Send model info message with menu
 */
export const sendModelMsg = async (
    ctx: Context,
    checkModelMenu: Menu<Context>
): Promise<void> => {
    await ctx.reply(
        '当前模型：`' +
            getCurrentModel() +
            '`\n\n点击下方按钮快速切换或使用 `/model `+模型名 手动指定',
        { reply_markup: checkModelMenu, parse_mode: 'Markdown' }
    );
};

/**
 * Change current model and show model menu
 */
export const changeModel = async (
    ctx: Context,
    model: string,
    checkModelMenu: Menu<Context>
): Promise<void> => {
    setCurrentModel(model);
    await sendModelMsg(ctx, checkModelMenu);
};

/**
 * Retry last AI response
 */
export const retry = async (
    ctx: Context,
    retryMenu: Menu<Context>
): Promise<void> => {
    const message = ctx.update.callback_query?.message?.reply_to_message;
    const chatId = message?.chat.id;
    const messageId = message?.message_id;

    if (!chatId || !messageId) {
        return;
    }

    const dbMessage = await getMessage(chatId, messageId);

    const update = {
        ...ctx.update,
        ...message,
        message: message,
        reply_to_message: {
            message_id: dbMessage?.replyToId,
        },
    } as Update;

    const newCtx = new Context(update, ctx.api, ctx.me);

    // Check if this is a /picbanana command
    const picbananaCommand = await checkPicbananaCommand(newCtx);
    if (picbananaCommand) {
        await handlePicbananaCommand(newCtx, picbananaCommand, retryMenu);
        return;
    }

    // Otherwise, use normal reply
    await handleReply(newCtx, retryMenu, { mention: true });
};

/**
 * Escape text for Telegram MarkdownV2
 * @deprecated Use escapeMarkdownV2 from telegram/formatters instead
 */
export const safeTextV2 = (text: string): string => {
    if (!text) return '';
    return text.replace(/(?<!\\)([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
};
