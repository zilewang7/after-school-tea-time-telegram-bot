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

/** The application lifecycle; a decided row is never changed back */
export const ACCESS_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AccessApplicationStatus = (typeof ACCESS_APPLICATION_STATUSES)[number];

export const isAccessApplicationStatus = (value: string): value is AccessApplicationStatus =>
  ACCESS_APPLICATION_STATUSES.some((status) => status === value);

/** Where the application came from: the /apply command or the Mini App form */
export const ACCESS_APPLICATION_SOURCES = ['command', 'miniapp'] as const;
export type AccessApplicationSource = (typeof ACCESS_APPLICATION_SOURCES)[number];

export const isAccessApplicationSource = (value: string): value is AccessApplicationSource =>
  ACCESS_APPLICATION_SOURCES.some((source) => source === value);

/** How the decision message to the applicant ended */
export const ACCESS_DELIVERY_STATUSES = ['sent', 'failed'] as const;
export type AccessDeliveryStatus = (typeof ACCESS_DELIVERY_STATUSES)[number];

export const isAccessDeliveryStatus = (value: string): value is AccessDeliveryStatus =>
  ACCESS_DELIVERY_STATUSES.some((status) => status === value);

/**
 * One access application a trial user submitted (from /apply or the Mini App).
 *
 * Every application is kept, so a rejection with its comment stays readable and
 * a re-application is a new row. Only one row per user may be `pending` at a
 * time; the service enforces that inside a serialized transaction. The panel
 * changes `status`, `comment`, review fields and the delivery outcome; the
 * user-facing entry points only ever insert.
 */
export class AccessApplication extends Model<
  InferAttributes<AccessApplication>,
  InferCreationAttributes<AccessApplication>
> {
  declare id: CreationOptional<number>;
  // Telegram user id of the applicant
  declare userId: number;
  // The chat the application was submitted in; the decision is delivered there
  declare chatId: number;
  // The message the application answers, when it came from a command
  declare messageId: CreationOptional<number | null>;
  // "你是谁" / "你要做什么", trimmed by the service
  declare identity: string;
  declare purpose: string;
  // command | miniapp
  declare source: CreationOptional<string>;
  // pending | approved | rejected
  declare status: CreationOptional<string>;
  // The owner's optional message on the decision
  declare comment: CreationOptional<string | null>;
  declare reviewedBy: CreationOptional<number | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  // sent | failed; null while pending or not attempted
  declare deliveryStatus: CreationOptional<string | null>;
  declare deliveryError: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AccessApplication.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  messageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  identity: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  purpose: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'command',
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'pending',
  },
  comment: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  reviewedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  reviewedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  deliveryStatus: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  deliveryError: {
    type: DataTypes.TEXT,
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
  tableName: 'access_applications',
  timestamps: false,
  // The panel lists pending applications by recency; a user's history by recency
  indexes: [
    { fields: ['status', 'createdAt'] },
    { fields: ['userId', 'createdAt'] },
  ],
});
