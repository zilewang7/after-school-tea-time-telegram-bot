/**
 * The message a live reply answers, as the status page's members see it:
 * author and the opening words. Reads only the columns it shows (the row may
 * carry media bytes).
 */
import { Message } from '../../db/messageDTO.js';
import { displayNameOf, lookupDisplayNames } from '../views/display-names.js';

export const TRIGGER_EXCERPT_CHARS = 40;

export interface TriggerSummary {
    readonly messageId: number;
    readonly authorName: string;
    /** The first 40 characters of the text, or the media placeholder */
    readonly text: string;
}

const excerptOf = (text: string): string => {
    const characters = Array.from(text.replace(/\s+/g, ' ').trim());
    return characters.length <= TRIGGER_EXCERPT_CHARS
        ? characters.join('')
        : `${characters.slice(0, TRIGGER_EXCERPT_CHARS).join('')}…`;
};

/** null when the message is not stored (yet) */
export const findTriggerSummary = async (chatId: number, messageId: number): Promise<TriggerSummary | null> => {
    const message = await Message.findOne({
        where: { chatId, messageId },
        attributes: ['userId', 'userName', 'text', 'mediaHint'],
    });
    if (message === null) return null;

    const names = message.userId === null ? new Map<number, string>() : await lookupDisplayNames([message.userId]);
    const authorName =
        message.userId !== null && names.has(message.userId)
            ? displayNameOf(names, message.userId)
            : message.userName;
    const text = message.text ?? (message.mediaHint ? `[${message.mediaHint}]` : '');
    return { messageId, authorName, text: excerptOf(text) };
};
