import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from '@sequelize/core';
import { sequelize } from './config.js';

/** Latest Telegram update accepted for one stored message. */
export class MessageRevision extends Model<
  InferAttributes<MessageRevision>,
  InferCreationAttributes<MessageRevision>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  declare messageId: number;
  declare updateId: number;
  declare telegramTimestamp: number;
  declare updatedAt: CreationOptional<Date>;
}

MessageRevision.init({
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
  updateId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  telegramTimestamp: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'message_revisions',
  timestamps: false,
  indexes: [
    { fields: ['chatId', 'messageId'], unique: true },
    { fields: ['updatedAt'] },
  ],
});
