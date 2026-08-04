import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * User-declared context edges: one row per message that a `/chat` command
 * pulled into the context.
 *
 * The reply tree itself is NOT stored here — a reply carries its own
 * `replyToId` (written in the same INSERT as the row, so it can never be lost)
 * and is walked by reverse lookup. This table exists for the edges that have no
 * reply relation to derive from: the bystander messages `/chat` attaches.
 *
 * Insert-only, by design. The predecessor was a JSON column on the *parent*
 * message maintained by a read-modify-write, which lost updates, needed a lock,
 * and silently dropped everything when the parent row did not exist yet (a
 * `/chat` aimed at a reply the bot was still streaming). Here the edge belongs
 * to the `/chat` message that created it, and `bulkCreate({ ignoreDuplicates })`
 * makes a repeated trigger a no-op.
 */
export class MessageLink extends Model<
  InferAttributes<MessageLink>,
  InferCreationAttributes<MessageLink>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  /** The message that established the edge — i.e. the `/chat` command message */
  declare sourceMessageId: number;
  /** The message it pulled into the context */
  declare linkedMessageId: number;
  declare createdAt: CreationOptional<Date>;
}

MessageLink.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  sourceMessageId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  linkedMessageId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'message_links',
  timestamps: false,
  indexes: [
    // Every context build asks "what did this message pull in?"
    { fields: ['chatId', 'sourceMessageId'] },
    // Makes a repeated /chat trigger an ignorable duplicate instead of a second row
    { fields: ['chatId', 'sourceMessageId', 'linkedMessageId'], unique: true },
    // Expiry sweep in the hourly cleanup
    { fields: ['createdAt'] },
  ],
});
