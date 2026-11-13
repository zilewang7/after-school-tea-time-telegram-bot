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
 * One model the bot may offer in its menu (pricing design §P6).
 *
 * Rows are managed by the catalog service: seeded from the menu constants on a
 * fresh database, extended automatically when the price watcher sees a new
 * model of a known family, and never deleted by a watch run. `enabled=false`
 * keeps a known model out of the menu without forgetting it.
 *
 * `capabilities` is JSON (ModelCatalogCapabilities): kind/vision/imageOutput/
 * tools/reasoningEffort/contextTokens/outputTokens. The code that changes
 * prompts, tools or the image pipeline still keys off `src/ai/model-kinds.ts`;
 * this row is the data the future metadata-driven version will read.
 */
export class ModelCatalogEntryRow extends Model<
  InferAttributes<ModelCatalogEntryRow>,
  InferCreationAttributes<ModelCatalogEntryRow>
> {
  declare id: string;
  declare label: string;
  // 0 / 1; SQLite has no boolean
  declare enabled: number;
  // JSON ModelCatalogCapabilities
  declare capabilities: string;
  // Platform the id routes to (prefix routing stays code; this is metadata)
  declare platform: CreationOptional<string | null>;
  // The catalog entry the row was derived from, e.g. google-vertex/gemini-4-hydrogen
  declare catalogKey: CreationOptional<string | null>;
  declare source: string;
  declare sourceUrl: CreationOptional<string | null>;
  declare checkedOn: string;
  declare confidence: string;
  declare note: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModelCatalogEntryRow.init({
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
  },
  label: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  enabled: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  capabilities: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  platform: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  catalogKey: {
    type: DataTypes.STRING,
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
  tableName: 'model_catalog',
  timestamps: true,
  indexes: [
    { name: 'model_catalog_enabled', fields: ['enabled'] },
  ],
});
