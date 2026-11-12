/**
 * Priority PayGo hit counts over a set of reply_metrics rows (design §8.4).
 * Vertex downgrades a priority request silently when it has no capacity, so
 * the rate of rounds it really served at the priority tier is the switch's
 * whole value; it is measured over the replies that asked for it only.
 */
import type { ReplyMetricRecord } from '../../db/queries/reply-metrics.js';
import { ratioOf, type PriorityHitCounts } from '../views/stats-view.js';
import { sumOf } from './metric-samples.js';

const askedForPriority = (row: ReplyMetricRecord): boolean => row.tierRequested === 'priority';

export const countPriorityHits = (rows: readonly ReplyMetricRecord[]): PriorityHitCounts => {
    const requested = rows.filter(askedForPriority);
    const notRequested = rows.filter((row) => !askedForPriority(row));
    const requestedRounds = sumOf(requested.map((row) => row.rounds ?? 0));
    const hitRounds = sumOf(requested.map((row) => row.priorityRounds ?? 0));
    return {
        priorityReplies: requested.length,
        priorityRequestedRounds: requestedRounds,
        priorityHitRounds: hitRounds,
        priorityHitRate: ratioOf(hitRounds, requestedRounds),
        strayPriorityRounds: sumOf(notRequested.map((row) => row.priorityRounds ?? 0)),
    };
};
