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
 * One text file of one conversation's model workspace.
 *
 * The workspace is a virtual file system: rows keyed by (chatId,
 * conversationRootId, path), written and read only through the workspace
 * tools. Content is UTF-8 bytes in a BLOB so a later binary version needs no
 * schema change. `lastUsedAt` is the LRU key of the hourly 7-day cleanup;
 * `summary` is the first line the per-turn manifest shows (never the content).
 */
export class WorkspaceFile extends Model<
  InferAttributes<WorkspaceFile>,
  InferCreationAttributes<WorkspaceFile>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  /** Reply-tree root of the conversation this file belongs to */
  declare conversationRootId: number;
  /** Normalized relative path, e.g. `widgets/card.html` */
  declare path: string;
  declare content: Buffer;
  declare sizeBytes: number;
  /** First non-empty line, cleaned and capped, for the manifest */
  declare summary: CreationOptional<string>;
  /** From the extension; the delivery layer uses it for the document */
  declare mimeType: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  /** Last read/write/edit/preview; the cleanup compares this with oneWeekAgo */
  declare lastUsedAt: Date;
}

WorkspaceFile.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  conversationRootId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  path: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  content: {
    type: DataTypes.BLOB,
    allowNull: false,
  },
  sizeBytes: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  summary: {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: '',
  },
  mimeType: {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: 'text/plain',
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
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'workspace_files',
  timestamps: false,
  indexes: [
    // One path per conversation; concurrent writers serialize on this
    { unique: true, fields: ['chatId', 'conversationRootId', 'path'] },
    // The manifest lists the newest files of one conversation
    { fields: ['chatId', 'conversationRootId', 'updatedAt'] },
    // The hourly cleanup scans by LRU
    { fields: ['lastUsedAt'] },
  ],
});
