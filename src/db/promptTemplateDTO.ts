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
 * One user-maintained prompt template (design 2026-1119-1146 §D1).
 *
 * Templates are data, not code: any panel user may create one, and only its
 * creator or the owner may edit or delete it. `chat_settings` holds which ids a
 * chat manually enabled, so nothing here is per-chat.
 *
 * `modelPatterns` is canonical JSON (a string array of glob rules: only `*` is
 * a wildcard, matching an id in full, case-insensitively). An empty array means
 * the author set no loading rule: the template never auto-loads and only a chat
 * that enables it by hand loads it. The array lives in one column because it is
 * small and every reader takes the whole list anyway. `enabled` is the author's
 * master switch: a disabled template loads in no chat, while the chats' enable
 * lists keep the id.
 *
 * `id` explicitly autoincrements so a deleted id is never handed to a new
 * template: a stale id in a chat's enable list must stay stale.
 */
export class PromptTemplateRecord extends Model<
  InferAttributes<PromptTemplateRecord>,
  InferCreationAttributes<PromptTemplateRecord>
> {
  declare id: CreationOptional<number>;
  // 1-40 code points, unique per creator
  declare name: string;
  // 1-4000 code points
  declare content: string;
  // Canonical JSON string[] of glob rules; '[]' = no rule (manual enable only)
  declare modelPatterns: CreationOptional<string>;
  // Composition order, ascending; 0-100000
  declare sortOrder: CreationOptional<number>;
  // 'global' = every panel user; 'group' = the creator's groups; 'private' = private chats only
  declare visibility: CreationOptional<string>;
  // The author's master switch; 0 = load in no chat
  declare enabled: CreationOptional<boolean>;
  // Telegram user id of the creator
  declare createdBy: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PromptTemplateRecord.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  modelPatterns: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
  },
  sortOrder: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  visibility: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: 'global',
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  createdBy: {
    type: DataTypes.INTEGER,
    allowNull: false,
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
  tableName: 'prompt_templates',
  timestamps: true,
  indexes: [
    // A creator cannot have two templates of the same name; different creators may
    { name: 'prompt_templates_creator_name_unique', unique: true, fields: ['createdBy', 'name'] },
  ],
});
