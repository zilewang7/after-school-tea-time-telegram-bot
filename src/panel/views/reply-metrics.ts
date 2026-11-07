/**
 * Per-version reply metrics of the reply detail view.
 *
 * PHASE 3 HOOK: reply_metrics does not exist yet, so every version shows
 * `metrics: null` ("无指标"). Phase 3 replaces `loadReplyMetrics` with a read
 * of every reply_metrics row of (chatId, firstMessageId) — index
 * reply_metrics_chat_first — keyed by versionId, and replaces
 * `ReplyMetricsView` with the real shape. For observers it must drop
 * triggerUserId and any other per-person column, keeping only timings,
 * tokens, tools, outcome and errorKind (design §6.2 回复详情).
 */
import type { VisibleAccess } from '../types.js';

/** One version's metrics as the API returns them (phase 3 defines the fields) */
export type ReplyMetricsView = Readonly<Record<string, unknown>>;

/** versionId → that version's metrics */
export type ReplyMetricsByVersion = ReadonlyMap<number, ReplyMetricsView>;

/** Phase 3: read reply_metrics here, redacted for observers. Until then nothing is recorded. */
export const loadReplyMetrics = async (
    _chatId: number,
    _firstMessageId: number,
    _access: VisibleAccess
): Promise<ReplyMetricsByVersion | null> => null;
