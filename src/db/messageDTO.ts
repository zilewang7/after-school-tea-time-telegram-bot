import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { sequelize } from './config';

export class Message extends Model<InferAttributes<Message>, InferCreationAttributes<Message>> {
  declare chatId: number;
  declare messageId: number;
  declare fromBotSelf: boolean;
  declare date: Date;
  declare userName: string;
  declare text: string | null;
  declare file: Buffer | null;
  declare replyToId: number | null;
  declare replies: string;
}

Message.init({
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  messageId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  fromBotSelf: {
    type: DataTypes.BOOLEAN
  },
  date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
  userName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  file: {
    type: DataTypes.BLOB,
    allowNull: true,
  },
  replyToId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  replies: {
    type: DataTypes.JSON,
    defaultValue: '[]',
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'telegram_messages',
});
