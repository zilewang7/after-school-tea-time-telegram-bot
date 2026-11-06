import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Per-chat settings changed from the panel (and `/model`). A missing row means
 * every default applies. Never cleaned.
 *
 * The whole table is held in memory by chat-settings-service; that service is
 * the only writer, so the cache never goes stale.
 */
export class ChatSettingsRecord extends Model<
  InferAttributes<ChatSettingsRecord>,
  InferCreationAttributes<ChatSettingsRecord>
> {
  declare chatId: number;
  // Free model id (<= 64 chars); NULL = follow the global default
  declare model: CreationOptional<string | null>;
  // <= 2000 code points, rendered into the runtime block; NULL = none
  declare promptAddendum: CreationOptional<string | null>;
  declare paused: CreationOptional<boolean>;
  // Owner-only switch: members become read-only
  declare settingsLocked: CreationOptional<boolean>;
  declare updatedAt: Date;
  // Telegram user id of the last writer
  declare updatedBy: CreationOptional<number | null>;
}

ChatSettingsRecord.init({
  chatId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
  model: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  promptAddendum: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  paused: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  settingsLocked: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
}, {
  sequelize,
  tableName: 'chat_settings',
  timestamps: false,
});
