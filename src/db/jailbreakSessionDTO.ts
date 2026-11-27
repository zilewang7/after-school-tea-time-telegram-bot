import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
} from '@sequelize/core';
import { DataTypes, Model } from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * One row per reply tree that runs under a jailbreak policy (design
 * 2026-1128-0045). The scope is `(chatId, rootMessageId)`: the tree the `/jb`
 * command started, and nothing else — sibling trees and other chats keep the
 * static system prompt byte for byte.
 *
 * The policy text itself lives in `prompt_templates` (`profileId`), so the
 * panel can edit it; this table only records which tree uses which template
 * and, optionally, which model that tree overrides to.
 */
export class JailbreakSessionRecord extends Model<
  InferAttributes<JailbreakSessionRecord>,
  InferCreationAttributes<JailbreakSessionRecord>
> {
  declare chatId: number;
  /** The `/jb` message: every reply in its tree reads this row */
  declare rootMessageId: number;
  /** `prompt_templates.id` holding the policy text */
  declare profileId: number;
  /** Model override for this tree; NULL = follow the chat's model */
  declare model: CreationOptional<string | null>;
  /** Telegram user id that ran the command */
  declare createdBy: number;
  declare createdAt: CreationOptional<Date>;
  /** After this instant the row is ignored (and swept) */
  declare expiresAt: Date;
}

JailbreakSessionRecord.init(
  {
    chatId: { type: DataTypes.INTEGER, primaryKey: true },
    rootMessageId: { type: DataTypes.INTEGER, primaryKey: true },
    profileId: { type: DataTypes.INTEGER, allowNull: false },
    model: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
    createdBy: { type: DataTypes.INTEGER, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize,
    tableName: 'jailbreak_sessions',
    timestamps: false,
    indexes: [{ name: 'jailbreak_sessions_expires', fields: ['expiresAt'] }],
  }
);
