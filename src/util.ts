/**
 * Utility functions
 */
import { Context } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';

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

