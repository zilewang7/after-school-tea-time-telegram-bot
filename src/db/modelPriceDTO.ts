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

/** The service tiers we actually request; order matches the pricing design */
export const PRICE_TIERS = ['standard', 'priority'] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const isPriceTier = (value: string): value is PriceTier =>
  PRICE_TIERS.some((tier) => tier === value);

/** Who supplied a price row; the panel shows this verbatim */
export const PRICE_SOURCES = ['manual', 'models-dev', 'official', 'ephone'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const isPriceSource = (value: string): value is PriceSource =>
  PRICE_SOURCES.some((source) => source === value);

export const PRICE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCES)[number];

export const isPriceConfidence = (value: string): value is PriceConfidence =>
  PRICE_CONFIDENCES.some((confidence) => confidence === value);

/**
 * One price row of one model and tier, valid over `[effectiveFrom, effectiveTo)`.
 *
 * Rows are append-only: a price change closes the old row (effectiveTo is the
 * instant the next one starts) and adds a new one. A row without effectiveTo
 * stays open. The owner approves changes from a private-chat message; only the
 * service writes here, and every write is audited in settings_audit (scope
 * 'pricing').
 */
export class ModelPriceEntry extends Model<
  InferAttributes<ModelPriceEntry>,
  InferCreationAttributes<ModelPriceEntry>
> {
  declare id: CreationOptional<number>;
  declare model: string;
  // standard | priority
  declare tier: string;
  // USD per 1M tokens; cachedInputPerM is the cache-hit price, cacheWritePerM
  // the Anthropic-style cache write (null = falls back to inputPerM)
  declare inputPerM: number;
  declare cachedInputPerM: number;
  declare cacheWritePerM: CreationOptional<number | null>;
  declare outputPerM: number;
  // Image-modality output tokens (Gemini image models)
  declare imageOutputPerM: CreationOptional<number | null>;
  // Per image, only for image rows that carry no usage at all
  declare perImageUsd: CreationOptional<number | null>;
  // UTC instants; effectiveTo NULL = open-ended
  declare effectiveFrom: Date;
  declare effectiveTo: CreationOptional<Date | null>;
  // manual | models-dev | official | ephone
  declare source: string;
  declare sourceUrl: CreationOptional<string | null>;
  // YYYY-MM-DD the value was last checked against the source
  declare checkedOn: string;
  // high | medium | low
  declare confidence: string;
  declare note: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModelPriceEntry.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  model: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  tier: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  inputPerM: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  cachedInputPerM: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  cacheWritePerM: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  outputPerM: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  imageOutputPerM: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  perImageUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
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
  source: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  sourceUrl: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  checkedOn: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  confidence: {
    type: DataTypes.STRING,
    allowNull: false,
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
  tableName: 'model_price_entries',
  timestamps: true,
  indexes: [
    { name: 'model_price_entries_lookup', fields: ['model', 'tier', 'effectiveFrom'] },
  ],
});
