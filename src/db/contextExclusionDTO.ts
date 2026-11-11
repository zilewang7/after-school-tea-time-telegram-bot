import type {
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import {
  DataTypes,
  Model,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Messages a chat member took out of the model's context from the panel. The
 * whole chat is affected: a message reached through several conversations
 * leaves all of them. A bot reply is stored under its firstMessageId.
 *
 * Dropped together with its message, not on its own clock: the hourly cleanup
 * removes a row only once it is older than 7 days and neither the message row
 * nor the bot_responses row exists any more (a bot row's date is reset on
 * every finalize and version switch, so a plain 7-day expiry would let an
 * excluded reply slip back into the context).
 */
export class ContextExclusion extends Model<
  InferAttributes<ContextExclusion>,
  InferCreationAttributes<ContextExclusion>
> {
  declare chatId: number;
  // Canonical id: a bot reply uses its firstMessageId
  declare messageId: number;
  declare createdAt: Date;
  // Telegram user id of the member who excluded it
  declare createdBy: number;
}

ContextExclusion.init({
  chatId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
  },
  messageId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  createdBy: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'context_exclusions',
  timestamps: false,
});
