/**
 * The user tier of one reply (design D1-C): the full-tier roster is maintained
 * from group membership, not from a per-user list.
 *
 * full = owner, a current member of an access group, a user explicitly listed
 * in TOOL_CHAT_IDS (its positive entries are private chats, i.e. users), or a
 * user the owner admitted. A message posted in an access group proves membership
 * without an API call; everywhere else getChatMember answers live, so a member
 * who was kicked is trial on the next message.
 *
 * ACCESS_TIERS=0 disables the feature: everyone is full (today's behavior).
 */
import { getOwnerUserId } from '../config/owner.js';
import { getToolConfig } from '../config/tool-config.js';
import { accessTiersEnabled, getAccessGroupIds, TRIAL_MODEL } from '../config/trial-access.js';
import { spokeWithinDays } from '../db/queries/panel-registry.js';
import { checkGroupMembership } from './access-membership.js';
import { isUserAdmitted, latestApplicationOf, type LatestApplicationSummary } from './user-access-cache.js';

export type AccessTier = 'owner' | 'full' | 'trial';

/** How far back a spoken message still vouches for membership when the API cannot answer */
const SPOKEN_FALLBACK_DAYS = 30;

export const isTrialTier = (tier: AccessTier): boolean => tier === 'trial';

/** Whether `chatId` is one of the groups whose members are full (design D1-C) */
export const isAccessGroupChat = (chatId: number | null | undefined): boolean =>
    chatId !== null && chatId !== undefined && getAccessGroupIds().has(chatId);

/** A member of any access group; a lookup failure falls back to recent speaking */
const isMemberOfAccessGroups = async (userId: number): Promise<boolean> => {
    for (const groupId of getAccessGroupIds()) {
        const membership = await checkGroupMembership(groupId, userId);
        if (membership === 'member') return true;
        // Network / 5xx / deadline: a recent message in the group still vouches,
        // the same fallback the panel's chat access uses
        if (membership === 'unknown' && (await spokeWithinDays(groupId, userId, SPOKEN_FALLBACK_DAYS))) {
            return true;
        }
    }
    return false;
};

/**
 * `userId` null: a stored message without an author id, treated as a stranger.
 * `triggerChatId` is the chat the triggering message arrived in; null when the
 * caller has no chat scope (only the panel does, and it resolves its own tier).
 */
export const resolveAccessTier = async (
    userId: number | null,
    triggerChatId: number | null = null
): Promise<AccessTier> => {
    if (userId !== null && getOwnerUserId() === userId) return 'owner';
    if (!accessTiersEnabled()) return 'full';
    if (userId === null) return 'trial';
    // TOOL_CHAT_IDS holds both chats and users; only a positive entry is a
    // private chat (chat id === user id), so `has(userId)` means "this user is
    // listed" only for a real Telegram user id
    if (userId > 0 && getToolConfig().toolChatIds.has(userId)) return 'full';
    if (isUserAdmitted(userId)) return 'full';
    // Only a member can post in an access group, so the message itself is proof
    if (isAccessGroupChat(triggerChatId)) return 'full';
    return (await isMemberOfAccessGroups(userId)) ? 'full' : 'trial';
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
export const resolveTriggerAccess = async (
    userId: number | null,
    name: string | null,
    triggerChatId: number | null = null,
    tier?: AccessTier
): Promise<TriggerAccessInfo> => {
    const resolved = tier ?? (await resolveAccessTier(userId, triggerChatId));
    return {
        userId,
        name,
        tier: resolved,
        application: isTrialTier(resolved) && userId !== null ? latestApplicationOf(userId) : null,
    };
};
