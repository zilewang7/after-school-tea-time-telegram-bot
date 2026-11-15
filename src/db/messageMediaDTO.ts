/**
 * The pictures of one bot reply, as message-side rows (v5 unified media).
 *
 * A reply's pictures live in three places and each has one job: the version
 * keeps what was delivered (`media[]`, for replay/panel), `media_cache` keeps
 * the bytes once (content-addressed), and this table ties the pictures to the
 * bot's message row so the context builder and the panel can list them without
 * parsing a version's JSON (which can hold whole media blocks' text).
 *
 * `ordinal` is 1-based delivery order and is what `#N` 的第 k 张图 indexes.
 * Rows are rewritten whole when a reply is finalized or a version is switched,
 * and are deleted with the message row by `deleteStaleMessagesInChunks`.
 */
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { DataTypes, Model } from '@sequelize/core';
import type { ReplyMediaPlacement } from '../shared/reply-media.js';
import { sequelize } from './config.js';

/** One stored picture of a reply message, without the row's own identity */
export interface StoredMessageMedia {
  /** 1-based delivery order; the context's `#N 的第 k 张图` */
  ordinal: number;
  /** media_cache key of the bytes (replyMediaKeyOf); empty only for legacy rows */
  mediaKey: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  /** Where it went: inside the rich body, or as a trailing message/album picture */
  placement: ReplyMediaPlacement;
}

export class MessageMedia extends Model<
  InferAttributes<MessageMedia>,
  InferCreationAttributes<MessageMedia>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  declare messageId: number;
  declare ordinal: number;
  declare mediaKey: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare caption: CreationOptional<string | null>;
  declare placement: string;
  declare createdAt: CreationOptional<Date>;
}

MessageMedia.init({
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
  mediaKey: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  sizeBytes: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  caption: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  placement: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'message_media',
  timestamps: false,
  indexes: [
    // One row per picture of one message; rewriting a version replaces them whole
    { fields: ['chatId', 'messageId', 'ordinal'], unique: true },
    // The context/panel read path and the cleanup's key batches both filter on the pair
    { fields: ['chatId', 'messageId'] },
  ],
});

/** Project a stored row onto the shape the context/panel code speaks */
export const toStoredMessageMedia = (row: MessageMedia): StoredMessageMedia => ({
  ordinal: row.ordinal,
  mediaKey: row.mediaKey,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  ...(row.caption === null ? {} : { caption: row.caption }),
  placement: row.placement === 'inline' ? 'inline' : 'attachment',
});
