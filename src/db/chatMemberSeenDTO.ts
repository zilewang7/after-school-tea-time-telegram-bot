import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Who has spoken in which group. Never cleaned.
 *
 * The panel's chat list uses it as the candidate set for a member, and the
 * membership check falls back to it (spoke within 30 days) when the Bot API
 * call fails. Human senders only: bots, messages with sender_chat (anonymous
 * admins, channel posts), GroupAnonymousBot and the Telegram service account
 * are never recorded. Private chats have no rows.
 */
export class ChatMemberSeen extends Model<
  InferAttributes<ChatMemberSeen>,
  InferCreationAttributes<ChatMemberSeen>
> {
  declare chatId: number;
  declare userId: number;
  declare firstSeenAt: Date;
  declare lastSeenAt: Date;
  // Messages counted since the row was created; a lower bound, see panel-registry
  declare messageCount: CreationOptional<number>;
}

ChatMemberSeen.init({
  chatId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
  },
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
  },
  firstSeenAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  messageCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  sequelize,
  tableName: 'chat_members_seen',
  timestamps: false,
  // A member's chat list: the groups one user has spoken in, newest first
  indexes: [
    { name: 'chat_members_seen_user', fields: ['userId', 'lastSeenAt'] },
  ],
});
