/**
 * The user tier of one reply, decided from the trigger user alone (design D1-B).
 *
 * full = owner, or a user id listed in TOOL_CHAT_IDS (its positive entries are
 * private chats, i.e. users), or a user the owner admitted. Chat whitelists keep
 * their old job — which tools a chat offers — and never grant the full tier.
 *
 * ACCESS_TIERS=0 disables the feature: everyone is full (today's behavior).
 */
import { getOwnerUserId } from '../config/owner.js';
import { getToolConfig } from '../config/tool-config.js';
import { accessTiersEnabled, TRIAL_MODEL } from '../config/trial-access.js';
import { isUserAdmitted, latestApplicationOf, type LatestApplicationSummary } from './user-access-cache.js';

export type AccessTier = 'owner' | 'full' | 'trial';

export const isTrialTier = (tier: AccessTier): boolean => tier === 'trial';

/** `userId` null: a stored message without an author id, treated as a stranger */
export const resolveAccessTier = (userId: number | null): AccessTier => {
    if (userId !== null && getOwnerUserId() === userId) return 'owner';
    if (!accessTiersEnabled()) return 'full';
    if (userId === null) return 'trial';
    // TOOL_CHAT_IDS holds both chats and users; only a positive entry is a
    // private chat (chat id === user id), so `has(userId)` means "this user is
    // listed" only for a real Telegram user id
    if (userId > 0 && getToolConfig().toolChatIds.has(userId)) return 'full';
    if (isUserAdmitted(userId)) return 'full';
    return 'trial';
};

/** The model one reply actually uses: a trial user is pinned to the cheap one */
export const effectiveReplyModel = (tier: AccessTier, chatModel: string): string =>
    isTrialTier(tier) ? TRIAL_MODEL : chatModel;

/** What the runtime block tells the model about who triggered this reply */
export interface TriggerAccessInfo {
    readonly userId: number | null;
    readonly name: string | null;
    readonly tier: AccessTier;
    /** The trigger user's latest application, only for trial turns */
    readonly application: LatestApplicationSummary | null;
}

/** `tier` lets a caller reuse a decision it already made (the retry path) */
export const resolveTriggerAccess = (
    userId: number | null,
    name: string | null,
    tier: AccessTier = resolveAccessTier(userId)
): TriggerAccessInfo => ({
    userId,
    name,
    tier,
    application: isTrialTier(tier) && userId !== null ? latestApplicationOf(userId) : null,
});
