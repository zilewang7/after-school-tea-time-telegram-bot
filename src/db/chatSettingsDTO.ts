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
  // Canonical JSON of the panel's per-chat tool switches; NULL = follow the env
  declare toolOverrides: CreationOptional<string | null>;
  // Owner-only Priority PayGo switch; NULL = follow the global switch
  declare geminiPriority: CreationOptional<boolean | null>;
  // Thinking level: NULL = the model default, 'off' = thinking off, else a graded effort
  declare thinkingEffort: CreationOptional<string | null>;
  // Experimental rich replies (presentation only); NULL = off, like a missing row
  declare richReplies: CreationOptional<boolean | null>;
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
  toolOverrides: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  // Added after the table shipped: schema-migrations.ts adds it to an existing table
  geminiPriority: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: null,
  },
  // Added after the table shipped too: a TEXT value from the thinking-effort closed set
  thinkingEffort: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  // Added after the table shipped as well: nullable, so the migration needs no backfill
  richReplies: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: null,
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
