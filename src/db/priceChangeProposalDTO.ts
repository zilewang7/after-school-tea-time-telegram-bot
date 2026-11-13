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

/** What a proposal would do: replace a window, add a model, or only remind of an expiry */
export const PROPOSAL_KINDS = ['update', 'new_model', 'expiry'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const isProposalKind = (value: string): value is ProposalKind =>
  PROPOSAL_KINDS.some((kind) => kind === value);

/** pending → approved | rejected | superseded | expired; decided rows never change */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'superseded', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * One pending price change the watcher found, waiting for the owner's button.
 *
 * The watcher only inserts (or supersedes a pending row with a newer value);
 * the approval service moves it to approved/rejected inside one transaction and
 * writes the resulting price row. `payload` and `baseline` are JSON of a
 * PriceEntry snapshot, so the message and the audit can show exactly what was
 * proposed even if the table changes later.
 */
export class PriceChangeProposal extends Model<
  InferAttributes<PriceChangeProposal>,
  InferCreationAttributes<PriceChangeProposal>
> {
  declare id: CreationOptional<number>;
  // update | new_model | expiry
  declare kind: string;
  declare model: string;
  // standard | priority
  declare tier: string;
  // The window start the payload applies from (UTC); the dedupe key of a pending row
  declare effectiveFrom: Date;
  declare effectiveTo: CreationOptional<Date | null>;
  // JSON PriceEntry snapshot
  declare payload: string;
  // JSON PriceEntry snapshot of the row this replaces; null for new_model
  declare baseline: CreationOptional<string | null>;
  declare detectedAt: Date;
  // pending | approved | rejected | superseded | expired
  declare status: string;
  declare decidedAt: CreationOptional<Date | null>;
  declare decidedBy: CreationOptional<number | null>;
  // The price_watch_run that found it
  declare runId: CreationOptional<number | null>;
  // The private-chat approval message that carries it (for edit/resend)
  declare messageId: CreationOptional<number | null>;
  // One line shown to the owner (why the watcher suggested this change)
  declare note: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PriceChangeProposal.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  kind: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  model: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  tier: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  effectiveFrom: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  effectiveTo: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  payload: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  baseline: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  detectedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'pending',
  },
  decidedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  decidedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  runId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  messageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  note: {
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
  tableName: 'price_change_proposals',
  timestamps: true,
  indexes: [
    { name: 'price_change_proposals_status', fields: ['status', 'detectedAt'] },
    { name: 'price_change_proposals_model', fields: ['model', 'tier', 'effectiveFrom'] },
  ],
});
