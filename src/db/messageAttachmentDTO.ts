import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from '@sequelize/core';
import { sequelize } from './config.js';

export type MessageAttachmentStatus = 'pending' | 'ready' | 'failed' | 'omitted';
export type MessageAttachmentSource = 'text' | 'caption' | 'rich_message';

/** One custom-emoji occurrence anchored to a Telegram message. */
export class MessageAttachment extends Model<
  InferAttributes<MessageAttachment>,
  InferCreationAttributes<MessageAttachment>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  declare messageId: number;
  declare ordinal: number;
  declare role: 'custom_emoji';
  declare source: MessageAttachmentSource;
  declare customEmojiId: string;
  declare offsetUtf16: CreationOptional<number | null>;
  declare lengthUtf16: CreationOptional<number | null>;
  declare fallbackText: string;
  declare mediaKey: CreationOptional<string | null>;
  declare status: MessageAttachmentStatus;
  declare failureReason: CreationOptional<string | null>;
  declare sourceRevision: number;
  declare sourceTimestamp: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

MessageAttachment.init({
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
  ordinal: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  role: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  customEmojiId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  offsetUtf16: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  lengthUtf16: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  fallbackText: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  mediaKey: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  failureReason: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  sourceRevision: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  sourceTimestamp: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'message_attachments',
  timestamps: false,
  indexes: [
    { fields: ['chatId', 'messageId', 'role', 'ordinal'], unique: true },
    { fields: ['chatId', 'messageId', 'status'] },
    { fields: ['role', 'status', 'updatedAt'] },
    { fields: ['customEmojiId'] },
    { fields: ['createdAt'] },
  ],
});
