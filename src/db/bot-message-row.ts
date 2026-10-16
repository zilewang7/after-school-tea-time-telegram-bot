/**
 * The bot's own row in the messages table: what later contexts read as the
 * bot's turn.
 *
 * Written whole, unlike saveMessage's merge. The versions of one reply differ
 * in every part — one has an image and the next has none, one carries Gemini
 * parts and the next comes from another model — and merging paired the new
 * version's text with the old version's image in every later context.
 */
import { Message } from './messageDTO.js';

export interface BotMessageRow {
    readonly chatId: number;
    /** A reply is stored under its first message id alone */
    readonly messageId: number;
    /** The user message the reply answers */
    readonly replyToId: number;
    readonly date: Date;
    readonly text: string | null;
    /** Provider parts replayed with the turn (a JSON column, typed as string by the DTO) */
    readonly modelParts: Message['modelParts'];
    readonly file: Buffer | null;
    readonly fileMime: string | null;
}

/** Replaces the row's content; whatever the new content lacks is cleared, not kept */
export const writeBotMessageRow = async (row: BotMessageRow): Promise<void> => {
    const botUserId = Number(process.env.BOT_USER_ID);
    const content = {
        fromBotSelf: true,
        // An unset BOT_USER_ID must not be written as NaN
        userId: Number.isFinite(botUserId) ? botUserId : null,
        userName: process.env.BOT_NAME || 'Bot',
        date: row.date,
        replyToId: row.replyToId,
        text: row.text,
        modelParts: row.modelParts,
        file: row.file,
        fileMime: row.fileMime,
        // A cached-media reference would win over `file` when a context reads the row
        fileUniqueId: null,
    };

    const existing = await Message.findOne({ where: { chatId: row.chatId, messageId: row.messageId } });
    if (existing) {
        existing.set(content);
        await existing.save();
        return;
    }

    await Message.create({ chatId: row.chatId, messageId: row.messageId, ...content });
};
