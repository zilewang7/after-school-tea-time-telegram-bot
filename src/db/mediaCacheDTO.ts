import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Content-addressed media cache.
 * Keyed by Telegram file_unique_id (stable across re-sends), so the same
 * sticker/image/video sent many times is downloaded/rendered only once.
 */
export class MediaCache extends Model<
  InferAttributes<MediaCache>,
  InferCreationAttributes<MediaCache>
> {
  declare fileUniqueId: string;
  declare mime: string;
  // Inline bytes for small media. Null when bytes live in GCS instead (see fileUri).
  declare data: Buffer | null;
  // GCS gs:// reference for large media (> INLINE_MAX_BYTES). Null for inline.
  declare fileUri: CreationOptional<string | null>;
  // Original file size in bytes (for logging / observability). Null if unknown.
  declare sizeBytes: CreationOptional<number | null>;
  declare kind: string;
  declare createdAt: CreationOptional<Date>;
  declare lastUsedAt: Date;
}

MediaCache.init({
  fileUniqueId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },
  mime: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  data: {
    type: DataTypes.BLOB,
    allowNull: true,
  },
  fileUri: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  sizeBytes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  kind: {
    type: DataTypes.STRING,
    allowNull: false,
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
  tableName: 'media_cache',
  timestamps: false,
});
