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

/** How one price watch run ended */
export const WATCH_OUTCOMES = ['ok', 'failed', 'skipped'] as const;
export type WatchOutcome = (typeof WATCH_OUTCOMES)[number];

export const isWatchOutcome = (value: string): value is WatchOutcome =>
  WATCH_OUTCOMES.some((outcome) => outcome === value);

/**
 * One price watch run (daily, or the owner's `/pricing`).
 *
 * The run row is what the panel's process status and the heartbeat read: a
 * recent successful run means the watcher lives. `notifiedMessageId` is the
 * private-chat message the run sent, so a later run can edit it instead of
 * sending a duplicate when the owner has not answered yet.
 */
export class PriceWatchRun extends Model<
  InferAttributes<PriceWatchRun>,
  InferCreationAttributes<PriceWatchRun>
> {
  declare id: CreationOptional<number>;
  declare startedAt: Date;
  declare finishedAt: CreationOptional<Date | null>;
  // ok | failed | skipped
  declare outcome: string;
  // Pending proposals created or refreshed by this run
  declare proposals: CreationOptional<number>;
  declare notifiedMessageId: CreationOptional<number | null>;
  declare error: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PriceWatchRun.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  finishedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  outcome: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  proposals: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  notifiedMessageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  error: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'price_watch_runs',
  timestamps: true,
  indexes: [
    { name: 'price_watch_runs_started', fields: ['startedAt'] },
  ],
});
