import type {
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import {
  DataTypes,
  Model,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Link-preview cache, content-addressed by URL.
 * One row per unique link: the preview text fetched live from Telegram via
 * luoxu (MTProto), plus references to preview media stored in MediaCache.
 * A ready row is final and serves every later message with the same URL; a
 * 'none'/'error' outcome is only a snapshot and is retried after its cooldown.
 */
export class LinkPreviewCache extends Model<
  InferAttributes<LinkPreviewCache>,
  InferCreationAttributes<LinkPreviewCache>
> {
  declare url: string;
  // 'ready': preview stored and usable; 'none': Telegram confirmed that this
  // URL has no preview; 'error': the last attempt failed temporarily (retried
  // after a short cooldown). Only rows written before this column's cooldown
  // existed can be missing lastAttemptAt.
  declare status: string;
  declare siteName: CreationOptional<string | null>;
  declare title: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare previewType: CreationOptional<string | null>;
  declare author: CreationOptional<string | null>;
  declare embedUrl: CreationOptional<string | null>;
  // Full Instant-View article text (cached_page flattened), when available.
  declare fullText: CreationOptional<string | null>;
  // JSON array of preview media descriptors:
  // [{ which, kind, mime, mediaKey, sizeBytes }] — mediaKey points into MediaCache.
  declare mediaItems: CreationOptional<string | null>;
  // Text recognized in the preview thumbnail / Instant-View images, so a model
  // that cannot see them still gets what they say.
  declare ocrText: CreationOptional<string | null>;
  declare ocrSourceTimestamp: CreationOptional<number | null>;
  declare ocrSourceUpdateId: CreationOptional<number | null>;
  // When the last acquisition attempt ended: 'none'/'error' rows are retried
  // after a cooldown measured from it. NULL = row predates the column.
  declare lastAttemptAt: CreationOptional<Date | null>;
  // 'message' | 'url': which luoxu data source produced this row (diagnostic).
  declare source: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare lastUsedAt: Date;
}

LinkPreviewCache.init({
  url: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  siteName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  title: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  previewType: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  author: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  embedUrl: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  fullText: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  mediaItems: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  ocrText: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  ocrSourceTimestamp: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  ocrSourceUpdateId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  lastAttemptAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  source: {
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
  tableName: 'link_preview_cache',
  timestamps: false,
  // LRU eviction in the hourly cleanup selects by lastUsedAt
  indexes: [
    { fields: ['lastUsedAt'] },
  ],
});
