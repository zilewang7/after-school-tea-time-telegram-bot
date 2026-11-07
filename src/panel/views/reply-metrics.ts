/**
 * Per-version reply metrics of the reply detail view: the reply_metrics row
 * each version wrote (the newest one, should a version ever have written
 * several). Versions without a row were generated before metrics existed, or
 * their write failed, and show `metrics: null` ("无指标"). Observers get the
 * rows without triggerUserId (listReplyMetricsByReply redacts them).
 */
import type { VisibleAccess } from '../types.js';
import { listReplyMetricsByReply, type ReplyMetricView } from './reply-metrics-view.js';

/** One version's metrics as the API returns them */
export type ReplyMetricsView = ReplyMetricView;

/** versionId → that version's metrics */
export type ReplyMetricsByVersion = ReadonlyMap<number, ReplyMetricsView>;

const newestOf = (rows: readonly ReplyMetricView[]): ReplyMetricView | null =>
    rows.reduce<ReplyMetricView | null>((newest, row) => (newest === null || row.id > newest.id ? row : newest), null);

export const loadReplyMetrics = async (
    chatId: number,
    firstMessageId: number,
    access: VisibleAccess
): Promise<ReplyMetricsByVersion> => {
    const rowsByVersion = await listReplyMetricsByReply(chatId, firstMessageId, { access });
    const newestByVersion = new Map<number, ReplyMetricsView>();
    for (const [versionId, rows] of rowsByVersion) {
        const newest = newestOf(rows);
        if (newest !== null) newestByVersion.set(versionId, newest);
    }
    return newestByVersion;
};
