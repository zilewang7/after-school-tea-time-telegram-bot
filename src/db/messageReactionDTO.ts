/**
 * One current reaction of one actor on one Telegram message.
 *
 * The table is a state snapshot, not an event log: a user changing their
 * reaction deletes the actor's old rows and inserts the new set, so the runtime
 * block can render "what stands on this message now" without reducing a
 * timeline. State is keyed by the message the user actually reacted to
 * (`sourceMessageId`), not by its reply: a user may react to the body and to the
 * sticker of the same reply, and both stand. `messageId` remains the canonical
 * id a context numbers by (a bot reply's first message id), so rendering and
 * cleanup still group per reply.
 *
 * Rows live exactly as long as their reply does: the hourly cleanup deletes
 * them in the same transaction as the message row, and a NOT EXISTS sweep
 * reaps the few rows whose bot response was cleaned before a message row was
 * ever written.
 */
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { DataTypes, Model } from '@sequelize/core';
import { sequelize } from './config.js';

export class MessageReaction extends Model<
  InferAttributes<MessageReaction>,
  InferCreationAttributes<MessageReaction>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  /** Canonical message id (the one `#N` stands for) */
  declare messageId: number;
  /**
   * The Telegram message id the user actually reacted to: a reply part (body
   * chunk, picture, sticker, widget, folded link message) or a user message.
   * NULL on rows written before the parts model: it stands for "the canonical
   * message / unknown", and such rows are superseded by the actor's next update
   * (see applyUserReactionUpdate).
   */
  declare sourceMessageId: number | null;
  /** Which part of the reply the source was (snapshotted from the delivery ledger) */
  declare part: string | null;
  /** Index within the part (body segment, picture number); null when meaningless */
  declare partIndex: number | null;
  /** Reactor's user id; null for anonymous administrators / channels */
  declare userId: number | null;
  /** The `actor_chat` of an anonymous reaction; null for a normal user */
  declare actorChatId: number | null;
  /** Display name snapshot at reaction time, same convention as message rows */
  declare userName: string | null;
  /** The bot's own reaction: the Bot API never reports it as an update */
  declare fromBotSelf: boolean;
  /** 'emoji' | 'custom_emoji' | 'paid' — the Bot API's ReactionType variant */
  declare kind: string;
  /** The standard emoji when kind = 'emoji' */
  declare emoji: string | null;
  /** The custom emoji id when kind = 'custom_emoji' */
  declare customEmojiId: string | null;
  /** When this row was written; a reaction change replaces the row */
  declare createdAt: CreationOptional<Date>;
}

MessageReaction.init({
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
  sourceMessageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  part: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  partIndex: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  userId: {
    // SQLite INTEGER is 64-bit; the sqlite dialect has no BIGINT type
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  actorChatId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  userName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  fromBotSelf: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  kind: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  emoji: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  customEmojiId: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'message_reactions',
  // Explicit createdAt (repo convention): the orphan sweep compares it.
  timestamps: false,
  indexes: [
    // Context injection reads one batch of canonical message ids, cleanup one batch of keys
    { fields: ['chatId', 'messageId'] },
    // An update replaces one actor's state on one source message
    { fields: ['chatId', 'sourceMessageId'] },
    // The NOT EXISTS orphan sweep scans rows older than the cutoff
    { fields: ['createdAt'] },
  ],
});
