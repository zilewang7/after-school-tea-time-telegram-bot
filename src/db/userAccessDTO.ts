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
 * A user the owner let into the full tier: the row is the grant.
 *
 * Revoking deletes the row (the settings audit keeps the history). Owner and
 * the users listed in TOOL_CHAT_IDS are full without a row here; this table
 * only holds what was granted from an application (or by hand later).
 */
export class UserAccess extends Model<
  InferAttributes<UserAccess>,
  InferCreationAttributes<UserAccess>
> {
  declare userId: number;
  // application | manual
  declare source: CreationOptional<string>;
  // The application that granted it, when one did
  declare applicationId: CreationOptional<number | null>;
  // Telegram user id of the owner who granted it
  declare grantedBy: CreationOptional<number | null>;
  declare grantedAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

UserAccess.init({
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: false,
  },
  source: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'application',
  },
  applicationId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  grantedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  grantedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'user_access',
  timestamps: false,
});
