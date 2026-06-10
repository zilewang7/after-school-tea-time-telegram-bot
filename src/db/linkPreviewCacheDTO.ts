import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Link-preview cache, content-addressed by URL.
 * One row per unique link: the preview text fetched live from Telegram via
 * luoxu (MTProto), plus references to preview media stored in MediaCache.
 * The same URL re-sent by anyone hits this row and never re-fetches.
 */
export class LinkPreviewCache extends Model<
  InferAttributes<LinkPreviewCache>,
  InferCreationAttributes<LinkPreviewCache>
> {
  declare url: string;
  // 'ready': preview stored; 'none': Telegram has no preview for this URL
  // (cached too, so we don't retry on every message).
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
});
