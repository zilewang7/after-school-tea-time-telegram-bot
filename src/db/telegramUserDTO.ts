import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Telegram user roster, one row per user id ever seen.
 * Filled by autoSave from message authors, forwarded-from users and
 * text_mention entities; read at context-build time so the system prompt can
 * tell the model each user's @username / id for proper mentions. Messages
 * themselves keep carrying only the first name.
 */
export class TelegramUser extends Model<
  InferAttributes<TelegramUser>,
  InferCreationAttributes<TelegramUser>
> {
  declare userId: number;
  /** Handle without the leading @; null when the user has none */
  declare username: CreationOptional<string | null>;
  declare firstName: string;
  declare lastName: CreationOptional<string | null>;
  /** Telegram's is_bot flag; null = recorded before this column existed */
  declare isBot: CreationOptional<boolean | null>;
  declare updatedAt: Date;
}

TelegramUser.init({
  userId: {
    // SQLite INTEGER is 64-bit; the sqlite dialect has no BIGINT type
    type: DataTypes.INTEGER,
    primaryKey: true,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  isBot: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: null,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'telegram_users',
  timestamps: false,
  indexes: [
    // Roster lookups resolve plain-text @handles back to users
    { fields: ['username'] },
  ],
});
