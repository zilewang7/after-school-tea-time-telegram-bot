/**
 * The trial tier's spend quota (design D1/D2/§5.2): what one user's trial-tier
 * replies have cost so far, estimated at list prices, and whether that is over
 * the limit.
 *
 * Nothing is stored: the reply_metrics rows marked `accessTier = 'trial'` are
 * the record, and each one is priced at the price in force when it started
 * (usage-cost.ts), image generations included. A price change therefore
 * re-estimates the past exactly as the panel does, and a failed write costs a
 * row rather than corrupting a running total.
 *
 * Rows from before the tier column (NULL) never count: the quota starts with
 * the feature's release (design D1).
 */
import { accessTiersEnabled, trialSpendLimitUsd } from '../config/trial-access.js';
import { findTrialReplyMetricsByUser } from '../db/queries/reply-metrics.js';
import type { AccessTier } from './access-tier.js';
import { imageGenerationCostUsd, replyRowCostUsd } from './usage-cost.js';

export interface TrialSpend {
    /** Estimated list-price cost of the user's trial replies, chat and in-reply images */
    readonly usedUsd: number;
    /** TRIAL_SPEND_LIMIT_USD, default 3 */
    readonly limitUsd: number;
    /** usedUsd >= limitUsd: at the limit the next generation is refused */
    readonly exceeded: boolean;
    /** Rows nothing could price (unpriced model or no usage): reported, never counted as 0 */
    readonly unpricedRows: number;
}

/** What one user's trial-tier replies have cost; not affected by ACCESS_TIERS */
export const estimateTrialSpend = async (userId: number): Promise<TrialSpend> => {
    const rows = await findTrialReplyMetricsByUser(userId);
    let usedUsd = 0;
    let unpricedRows = 0;
    for (const row of rows) {
        const chatCost = replyRowCostUsd(row).costUsd;
        const imageCost = imageGenerationCostUsd(row).costUsd;
        if (chatCost === null && imageCost === null) {
            unpricedRows += 1;
            continue;
        }
        usedUsd += (chatCost ?? 0) + (imageCost ?? 0);
    }
    const limitUsd = trialSpendLimitUsd();
    return { usedUsd, limitUsd, exceeded: usedUsd >= limitUsd, unpricedRows };
};

/**
 * The quota gate of one generation attempt: null when nothing is limited (not
 * a trial user, no user id, or ACCESS_TIERS=0), the spend otherwise.
 */
export const checkTrialQuota = async (tier: AccessTier, userId: number | null): Promise<TrialSpend | null> => {
    if (tier !== 'trial' || userId === null || !accessTiersEnabled()) return null;
    return estimateTrialSpend(userId);
};
