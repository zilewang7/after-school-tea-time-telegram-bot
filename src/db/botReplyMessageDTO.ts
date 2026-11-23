/**
 * The delivery ledger of one bot reply: one row per message it actually put in
 * the chat.
 *
 * Telegram only tells us a bare message_id when a user reacts, so the reply
 * layer cannot tell a split body chunk from the sticker or the folded link
 * message by itself. This table records that mapping as the messages go out
 * (before finalize, so a reaction arriving in that window still resolves), and
 * stores which part of the reply each message is. A reaction row snapshots the
 * part, so a later version switch deleting the message does not lose the label.
 *
 * Rows live as long as their reply does: the hourly cleanup deletes them with
 * the message row and with the bot response, plus an orphan sweep for rows the
 * cascades cannot see.
 */
import type {
    CreationOptional,
    InferAttributes,
    InferCreationAttributes,
} from '@sequelize/core';
import { DataTypes, Model } from '@sequelize/core';
import { sequelize } from './config.js';

export class BotReplyMessage extends Model<
    InferAttributes<BotReplyMessage>,
    InferCreationAttributes<BotReplyMessage>
> {
    declare id: CreationOptional<number>;
    /** Chat the reply lives in */
    declare chatId: number;
    /** The Telegram message id of this part, as sent */
    declare messageId: number;
    /** The reply's first message id (the id a context numbers by) */
    declare canonicalMessageId: number;
    /** One of `ReplyPartKind` (stored as text; readers validate) */
    declare part: string;
    /** 1-based index within the kind (body segment, picture number); null when meaningless */
    declare partIndex: number | null;
    /** When the row was written/refreshed; cleanup compares it */
    declare createdAt: CreationOptional<Date>;
}

BotReplyMessage.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        chatId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        messageId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        canonicalMessageId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        part: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        partIndex: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null,
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        sequelize,
        tableName: 'bot_reply_messages',
        // Explicit createdAt (repo convention): the orphan sweep compares it.
        timestamps: false,
        indexes: [
            // Inbound normalization: message id -> its reply and part
            { fields: ['chatId', 'messageId'] },
            // Version switching / refresh / cleanup work per reply
            { fields: ['chatId', 'canonicalMessageId'] },
            { fields: ['createdAt'] },
        ],
    }
);
