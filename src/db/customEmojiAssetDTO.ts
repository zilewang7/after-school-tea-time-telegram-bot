import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from '@sequelize/core';
import { sequelize } from './config.js';

export type CustomEmojiAssetKind = 'static' | 'animated' | 'video';
export type CustomEmojiAssetStatus = 'ready' | 'failed';

/** Cached Telegram metadata and generated static preview for one custom emoji. */
export class CustomEmojiAsset extends Model<
  InferAttributes<CustomEmojiAsset>,
  InferCreationAttributes<CustomEmojiAsset>
> {
  declare customEmojiId: string;
  declare fileId: CreationOptional<string | null>;
  declare fileUniqueId: CreationOptional<string | null>;
  declare kind: CreationOptional<CustomEmojiAssetKind | null>;
  declare sourceMime: CreationOptional<string | null>;
  declare previewMediaKey: CreationOptional<string | null>;
  declare fallbackEmoji: CreationOptional<string | null>;
  declare needsRepainting: CreationOptional<boolean | null>;
  declare status: CustomEmojiAssetStatus;
  declare failureReason: CreationOptional<string | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare lastUsedAt: Date;
}

CustomEmojiAsset.init({
  customEmojiId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },
  fileId: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  fileUniqueId: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  kind: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  sourceMime: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  previewMediaKey: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  fallbackEmoji: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  needsRepainting: {
    type: DataTypes.BOOLEAN,
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
  resolvedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'custom_emoji_assets',
  timestamps: false,
  indexes: [
    { fields: ['fileUniqueId'] },
    { fields: ['lastUsedAt'] },
  ],
});
