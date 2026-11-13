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

/** pending → approved | rejected | superseded | expired; decided rows never change */
export const CAPABILITY_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'superseded', 'expired'] as const;
export type CapabilityProposalStatus = (typeof CAPABILITY_PROPOSAL_STATUSES)[number];

export const isCapabilityProposalStatus = (value: string): value is CapabilityProposalStatus =>
  CAPABILITY_PROPOSAL_STATUSES.some((status) => status === value);

/**
 * One capability change the watcher (or a probe import) found, waiting for the
 * owner's button (thinking-effort design 2026-1113-1742 §1.3).
 *
 * Separate from `price_change_proposals`: the price table has tiers and
 * effective windows, a capability payload is one model's whole
 * `ModelCatalogCapabilities` object. The watcher only inserts (or refreshes a
 * pending row with a newer payload); the approval service moves it to
 * approved/rejected inside one transaction and writes the catalog row.
 *
 * `payload` and `baseline` are JSON snapshots so the approval message and the
 * audit can show exactly what was proposed even after the catalog changed.
 */
export class ModelCapabilityProposal extends Model<
  InferAttributes<ModelCapabilityProposal>,
  InferCreationAttributes<ModelCapabilityProposal>
> {
  declare id: CreationOptional<number>;
  declare model: string;
  // JSON ModelCatalogCapabilities: the full object the apply would write
  declare payload: string;
  // JSON ModelCatalogCapabilities snapshot before the change; null = there was no data
  declare baseline: CreationOptional<string | null>;
  declare detectedAt: Date;
  // pending | approved | rejected | superseded | expired
  declare status: string;
  declare decidedAt: CreationOptional<Date | null>;
  declare decidedBy: CreationOptional<number | null>;
  // The price_watch_run (or import run) that found it
  declare runId: CreationOptional<number | null>;
  // The private-chat approval message that carries it (for edit/resend)
  declare messageId: CreationOptional<number | null>;
  // One line shown to the owner (changed fields + source/date/confidence)
  declare note: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModelCapabilityProposal.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  model: {
    type: DataTypes.STRING,
    allowNull: false,
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
  tableName: 'model_capability_proposals',
  timestamps: true,
  indexes: [
    { name: 'model_capability_proposals_status', fields: ['status', 'detectedAt'] },
    { name: 'model_capability_proposals_model', fields: ['model'] },
  ],
});
