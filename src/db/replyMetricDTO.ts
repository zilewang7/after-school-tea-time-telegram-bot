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
 * One row per reply attempt (a retry is its own row, on the same
 * firstMessageId with the next versionId). No blobs. Kept forever: the
 * hourly cleanup never touches this table.
 *
 * Token columns follow the normalized meaning of src/ai/usage (prompt includes
 * cache hits and writes, output includes reasoning); NULL = not reported.
 */
export class ReplyMetric extends Model<
  InferAttributes<ReplyMetric>,
  InferCreationAttributes<ReplyMetric>
> {
  declare id: CreationOptional<number>;
  declare chatId: number;
  declare userMessageId: number;
  // The bot reply's first message
  declare firstMessageId: number;
  // The version this finalize wrote; a retry shares firstMessageId
  declare versionId: number;
  // Never returned to observers
  declare triggerUserId: number | null;
  // The model actually passed to sendMessage
  declare model: string;
  declare platform: string;
  // Gemini lane (large-media | opencode-go | image); NULL elsewhere
  declare route: string | null;
  // chat | picbanana | picgpt
  declare commandType: string;
  declare isRetry: boolean;
  // Session created (placeholder sent); includes context building
  declare startedAt: Date;
  // Right before sendMessage; NULL when the reply failed before it
  declare requestStartedAt: Date | null;
  // First non-empty text / thinking chunk
  declare firstChunkAt: Date | null;
  declare finishedAt: Date;
  // ok | error | stopped | empty
  declare outcome: string;
  // rate_limit | timeout | network | upstream | content_filter | pre_request | other
  declare errorKind: string | null;
  // <= 200 chars
  declare errorSummary: string | null;
  // Model rounds reported (tool loop rounds; 1 without tools)
  declare rounds: number | null;
  declare toolCalls: number;
  declare toolFailures: number;
  // JSON [{ name, count, failed }]; NULL when no tool ran
  declare toolUsage: string | null;
  declare promptTokens: number | null;
  declare cachedTokens: number | null;
  declare cacheWriteTokens: number | null;
  declare outputTokens: number | null;
  declare thoughtsTokens: number | null;
  declare imageOutputTokens: number | null;
  declare contextMessages: number | null;
  declare contextImages: number | null;
  declare textChars: number | null;
  declare thinkingChars: number | null;
  declare hasImage: boolean;
  // session.images.length; per-image pricing uses it
  declare imageCount: number;
  declare hasSticker: boolean;
  declare hasFile: boolean;
  // Failed round attempts retried automatically inside the reply; NULL = none
  declare roundRetries: number | null;
  // 'priority' when the Priority PayGo header went out; NULL = standard request
  declare tierRequested: string | null;
  // The part actually served at the priority tier (Vertex trafficType); all NULL when none was
  declare priorityRounds: number | null;
  declare priorityPromptTokens: number | null;
  declare priorityCachedTokens: number | null;
  declare priorityOutputTokens: number | null;
  // Rounds carried over from a checkpoint; NULL = not a resumed attempt
  declare resumedRounds: number | null;
  // Rounds a checkpoint saved when this attempt failed or stopped; NULL = none saved
  declare checkpointRounds: number | null;
  // The chat's thinking level when the attempt started; NULL = the model default
  declare thinkingEffortRequested: string | null;
  // The level actually sent to the platform after clamping/fallback; NULL = nothing explicit
  declare thinkingEffortSent: string | null;
  // The degradation chain, e.g. 'xhigh->high'; NULL = none
  declare thinkingEffortFallback: string | null;
}

// Fresh option objects per column: Sequelize normalizes attribute definitions in place
const requiredInteger = () => ({ type: DataTypes.INTEGER, allowNull: false });
const nullableInteger = () => ({ type: DataTypes.INTEGER, allowNull: true, defaultValue: null });
const nullableDate = () => ({ type: DataTypes.DATE, allowNull: true, defaultValue: null });
const flag = () => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
const counter = () => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });

ReplyMetric.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // SQLite INTEGER is 64-bit; the sqlite dialect has no BIGINT type
  chatId: requiredInteger(),
  userMessageId: requiredInteger(),
  firstMessageId: requiredInteger(),
  versionId: requiredInteger(),
  triggerUserId: nullableInteger(),
  model: { type: DataTypes.STRING, allowNull: false },
  platform: { type: DataTypes.STRING, allowNull: false },
  route: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  commandType: { type: DataTypes.STRING, allowNull: false },
  isRetry: flag(),
  startedAt: { type: DataTypes.DATE, allowNull: false },
  requestStartedAt: nullableDate(),
  firstChunkAt: nullableDate(),
  finishedAt: { type: DataTypes.DATE, allowNull: false },
  outcome: { type: DataTypes.STRING, allowNull: false },
  errorKind: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  errorSummary: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  rounds: nullableInteger(),
  toolCalls: counter(),
  toolFailures: counter(),
  toolUsage: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  promptTokens: nullableInteger(),
  cachedTokens: nullableInteger(),
  cacheWriteTokens: nullableInteger(),
  outputTokens: nullableInteger(),
  thoughtsTokens: nullableInteger(),
  imageOutputTokens: nullableInteger(),
  contextMessages: nullableInteger(),
  contextImages: nullableInteger(),
  textChars: nullableInteger(),
  thinkingChars: nullableInteger(),
  hasImage: flag(),
  imageCount: counter(),
  hasSticker: flag(),
  hasFile: flag(),
  // Added after the table shipped: schema-migrations.ts adds them to an existing table
  roundRetries: nullableInteger(),
  tierRequested: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  priorityRounds: nullableInteger(),
  priorityPromptTokens: nullableInteger(),
  priorityCachedTokens: nullableInteger(),
  priorityOutputTokens: nullableInteger(),
  resumedRounds: nullableInteger(),
  checkpointRounds: nullableInteger(),
  // Added with the thinking-effort feature; all NULL on rows from before it
  thinkingEffortRequested: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  thinkingEffortSent: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  thinkingEffortFallback: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
}, {
  sequelize,
  tableName: 'reply_metrics',
  timestamps: false,
  indexes: [
    { name: 'reply_metrics_chat_time', fields: ['chatId', 'startedAt'] },
    { name: 'reply_metrics_time', fields: ['startedAt'] },
    // Reply detail: every attempt of one reply
    { name: 'reply_metrics_chat_first', fields: ['chatId', 'firstMessageId'] },
  ],
});
