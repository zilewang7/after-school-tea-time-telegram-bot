import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Chat registry: every chat the bot has seen a message in. Never cleaned.
 *
 * autoSave upserts the row next to the user roster (at most once per chat per
 * 60s), `/panel` upserts it right away, and the panel's own private chat is
 * created from initData when a user opens it before ever writing there.
 * Rows that existed before the panel came from the one-shot backfill and keep
 * a NULL title until the chat's next message.
 */
export class ChatRecord extends Model<
  InferAttributes<ChatRecord>,
  InferCreationAttributes<ChatRecord>
> {
  declare chatId: number;
  // private | group | supergroup | channel
  declare type: string;
  // Group title, or the user's first name for a private chat. The runtime block
  // never reads it for private chats (they render as "私聊").
  declare title: string | null;
  // Public @handle without the @, overwritten on every upsert (NULL included)
  declare username: string | null;
  declare firstSeenAt: Date;
  declare lastSeenAt: Date;
}

ChatRecord.init({
  chatId: {
    // SQLite INTEGER is 64-bit; the sqlite dialect has no BIGINT type
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  title: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  firstSeenAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'chats',
  timestamps: false,
});
