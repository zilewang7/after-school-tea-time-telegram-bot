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
 * Global key/value settings changed from the panel by the owner. Only
 * `defaultModel` exists today; a missing row means the env value applies.
 * Held in memory by chat-settings-service, its only writer.
 */
export class GlobalSetting extends Model<
  InferAttributes<GlobalSetting>,
  InferCreationAttributes<GlobalSetting>
> {
  declare key: string;
  declare value: string;
  declare updatedAt: Date;
  declare updatedBy: CreationOptional<number | null>;
}

GlobalSetting.init({
  key: {
    type: DataTypes.STRING,
    primaryKey: true,
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: false,
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
  tableName: 'global_settings',
  timestamps: false,
});
