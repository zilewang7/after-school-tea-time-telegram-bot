/**
 * Price-segmented cost estimate (design §4.2), shared by the statistics page
 * and the dashboard summary: a window that contains a price change is split at
 * the change instants, each slice is aggregated on its own and priced at the
 * price in force when the slice started. A reply therefore keeps the price it
 * was made under, and changing a price never rewrites the past.
 *
 * The slices add up to exactly the unsegmented aggregation, so the merged
 * usage (cost-estimate.ts `mergeUsageGroupRows`) is the row the API shows.
 */
import { findPriceAt, priceChangeInstants } from '../../config/model-pricing.js';
import {
    aggregateUsageByModelRoute,
    type MetricWindow,
    type UsageGroupRow,
} from '../../db/queries/reply-metrics.js';
import { priceUsageGroup, type PricedUsageGroup } from './cost-estimate.js';

/** One price segment of the window: `[start, until)` */
export interface PriceSegment {
    readonly start: Date;
    readonly until: Date;
}

/** `[since, until)` split at every price change inside it, oldest first */
export const priceSegmentsOf = (since: Date, until: Date): readonly PriceSegment[] => {
    const boundaries = [...priceChangeInstants(since, until), until];
    const segments: PriceSegment[] = [];
    let start = since;
    for (const end of boundaries) {
        segments.push({ start, until: end });
        start = end;
    }
    return segments;
};

/** Each segment's usage sums, priced at the price in force when it started */
export const pricedUsageGroupsInWindow = async (
    window: MetricWindow,
    until: Date
): Promise<PricedUsageGroup[]> => {
    const segments = priceSegmentsOf(window.since, until);
    const segmentGroups: UsageGroupRow[][] = await Promise.all(
        segments.map((segment) =>
            aggregateUsageByModelRoute({ ...window, since: segment.start, until: segment.until })
        )
    );
    return segments.flatMap((segment, index) =>
        (segmentGroups[index] ?? []).map((group) => priceUsageGroup(group, findPriceAt(group.model, segment.start)))
    );
};
