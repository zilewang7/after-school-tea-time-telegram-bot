import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { sequelize } from './config.js';

export class Message extends Model<InferAttributes<Message>, InferCreationAttributes<Message>> {
  declare chatId: number;
  declare messageId: number;
  declare fromBotSelf: boolean;
  declare date: Date;
  declare userName: string;
  declare text: string | null;
  declare quoteText: string | null;
  declare file: Buffer | null;
  declare fileMime: string | null;
  declare fileUniqueId: string | null;
  declare replyToId: number | null;
  declare replies: string;
  declare modelParts: string | null;
  /** Human-readable attached-media hint, e.g. "a picture" (+ failure status) */
  declare mediaHint: string | null;
  /** Forward origin, e.g. "user 张三" / "channel 某频道" */
  declare forwardOrigin: string | null;
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
  quoteText: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  file: {
    type: DataTypes.BLOB,
    allowNull: true,
  },
  fileMime: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  fileUniqueId: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
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
  modelParts: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
  },
  mediaHint: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  forwardOrigin: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
}, {
  sequelize,
  tableName: 'telegram_messages',
});
