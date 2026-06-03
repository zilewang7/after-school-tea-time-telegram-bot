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
  declare data: Buffer;
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
    allowNull: false,
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
