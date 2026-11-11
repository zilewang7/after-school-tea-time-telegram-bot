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
 * One friction point logged about the harness: by the model itself (a tool
 * description that misled it, a parameter it needed and did not get, an error
 * message that made it retry, a context format it had to work around) or by a
 * person from the control panel.
 *
 * `status` and `note` are changed by people (the owner, from the panel):
 * open → triaged → fixed / wontfix / duplicate. The model's tool only ever
 * inserts.
 */
export class HarnessIssue extends Model<
  InferAttributes<HarnessIssue>,
  InferCreationAttributes<HarnessIssue>
> {
  declare id: CreationOptional<number>;
  // open | triaged | fixed | wontfix | duplicate
  declare status: CreationOptional<string>;
  // bug | improvement | feature
  declare kind: string;
  // low | medium | high
  declare severity: CreationOptional<string | null>;
  declare title: string;
  declare body: string;
  // The tool the issue is about, when there is one (`send_sticker`)
  declare toolName: CreationOptional<string | null>;
  // Where it was reported from, for follow-up questions
  declare chatId: CreationOptional<number | null>;
  // The maintainer's handling note (the owner writes it from the panel)
  declare note: CreationOptional<string | null>;
  // model | user: who filed it
  declare source: CreationOptional<string>;
  // Telegram user id of the person who filed it; only for source = 'user'
  declare createdBy: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

HarnessIssue.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'open',
  },
  kind: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  severity: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  title: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  toolName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  // The next three exist on older databases through migrateHarnessIssuePanelColumns
  note: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  source: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'model',
  },
  createdBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  createdAt: {
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
  tableName: 'harness_issues',
  timestamps: false,
  // list_harness_issues filters by status and orders by recency
  indexes: [
    { fields: ['status', 'createdAt'] },
  ],
});
