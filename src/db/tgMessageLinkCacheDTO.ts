import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Cached snapshot of the message a `t.me` message link points at.
 *
 * One row per canonical link URL: the target message's author/text/date, the
 * message it replies to (one level), and references to the target's own media
 * in MediaCache. `source = 'db'` means the snapshot was built from our own
 * telegram_messages row (media is read back from there at build time);
 * `source = 'luoxu'` means it came from luoxu's MTProto client and its media
 * lives in MediaCache.
 */
export class TgMessageLinkCache extends Model<
  InferAttributes<TgMessageLinkCache>,
  InferCreationAttributes<TgMessageLinkCache>
> {
  declare url: string;
  // 'ready': snapshot stored; 'none': unreachable (deleted / not accessible),
  // cached so the same link is not re-fetched on every message.
  declare status: string;
  // 'db' | 'luoxu' | null when status is 'none'
  declare source: CreationOptional<string | null>;
  declare chatId: CreationOptional<number | null>;
  declare messageId: CreationOptional<number | null>;
  declare chatTitle: CreationOptional<string | null>;
  declare senderName: CreationOptional<string | null>;
  declare messageDate: CreationOptional<Date | null>;
  declare text: CreationOptional<string | null>;
  declare replyToId: CreationOptional<number | null>;
  // JSON array of the target's reply target:
  // [{ role: 'reply-to', messageId, senderName, date, text }]
  declare contextItems: CreationOptional<string | null>;
  // JSON array of the target's own media:
  // [{ kind, mime, sizeBytes, durationSeconds, mediaKey }] — mediaKey points into MediaCache
  declare mediaItems: CreationOptional<string | null>;
  declare unavailableReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare lastUsedAt: Date;
}

TgMessageLinkCache.init({
  url: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  messageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  chatTitle: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  senderName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  messageDate: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  replyToId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  contextItems: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  mediaItems: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  unavailableReason: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'tg_message_link_cache',
  timestamps: false,
  // LRU eviction in the hourly cleanup selects by lastUsedAt
  indexes: [
    { fields: ['lastUsedAt'] },
  ],
});
