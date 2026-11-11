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
 * Audit trail of every panel write (and `/model`). Read-only endpoints never
 * write here. Kept 365 days by the hourly cleanup.
 *
 * Value formats (both columns are text):
 * - model / defaultModel: the model id; NULL = follow global / back to env
 * - promptAddendum / note: the full text or NULL
 * - paused / settingsLocked: 'true' / 'false'
 * - exclude / include: newValue = canonical messageId
 * - link: newValue = JSON { rootId, linkMessageIds, attachedRoots }
 * - create: newValue = JSON { chatId, kind, title }
 * - status: old status / new status
 */
export class SettingsAudit extends Model<
  InferAttributes<SettingsAudit>,
  InferCreationAttributes<SettingsAudit>
> {
  declare id: CreationOptional<number>;
  declare actorId: number;
  // chat:<chatId> | global | issue:<issueId>
  declare scope: string;
  // model | promptAddendum | paused | settingsLocked | exclude | include | link
  // | defaultModel | create | status | note
  declare key: string;
  declare oldValue: CreationOptional<string | null>;
  declare newValue: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

SettingsAudit.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  actorId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  scope: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  key: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  oldValue: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  newValue: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'settings_audit',
  timestamps: false,
  // Per-scope history, newest first (the table is small: the 365-day cleanup scans it)
  indexes: [
    { name: 'settings_audit_scope_time', fields: ['scope', 'createdAt'] },
  ],
});
