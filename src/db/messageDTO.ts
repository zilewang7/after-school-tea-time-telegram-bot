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
  /**
   * Parsed `/chat` parameters when this message is a `/chat` summon, else null.
   * Written in the same INSERT as the row (autoSave already parses the command
   * to strip its prefix off the text), so "is this a /chat?" never depends on
   * the command handler having run. The messages it pulled in live in
   * `message_links`; a `/chat 1` has none, which is exactly why the marker
   * cannot be derived from those rows.
   */
  declare chatCommand: string | null;
  declare modelParts: string | null;
  /** Human-readable attached-media hint, e.g. "a picture" (+ failure status) */
  declare mediaHint: string | null;
  /** Forward origin, e.g. "user 张三" / "channel 某频道" */
  declare forwardOrigin: string | null;
  /** Text recognized in this message's images, for models that can't see them */
  declare ocrText: string | null;
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
  chatCommand: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
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
  ocrText: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
}, {
  sequelize,
  tableName: 'telegram_messages',
  // Every context build looks messages up by (chatId, messageId) dozens of
  // times; without this the lookup is a full table scan over rows that carry
  // multi-MB media blobs. The reply tree is walked by reverse lookup on
  // replyToId, level by level, so that pair needs an index just as much.
  indexes: [
    { fields: ['chatId', 'messageId'] },
    { fields: ['chatId', 'replyToId'] },
  ],
});
