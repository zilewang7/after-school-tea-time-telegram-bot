import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from '@sequelize/core';
import { sequelize } from './config.js';

/**
 * Danmaku snapshots of bilibili videos seen in chat, keyed by video+part.
 *
 * bilibili closes a video's danmaku pool server-side the moment the video is
 * deleted, and no public archive covers arbitrary UGC videos — so the only
 * reliable source after deletion is what we grabbed while the video was alive.
 * Every successful live fetch overwrites the row (danmaku keep accumulating),
 * an empty result never does. Rows are small (parsed entries as JSON, ≤1500
 * lines) and are the archive itself, so the hourly cleanup leaves them alone.
 */
export class BiliDanmakuSnapshot extends Model<
  InferAttributes<BiliDanmakuSnapshot>,
  InferCreationAttributes<BiliDanmakuSnapshot>
> {
  // "av117185330552123:p1" / "BV1uht86rEDA:p2"
  declare videoKey: string;
  // JSON array of { timeSec, weight, text }
  declare entries: string;
  declare entryCount: number;
  // When the snapshot was last refreshed from a live fetch
  declare capturedAt: CreationOptional<Date>;
}

BiliDanmakuSnapshot.init({
  videoKey: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },
  entries: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  entryCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  capturedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'bili_danmaku_snapshots',
  timestamps: false,
});
