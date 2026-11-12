/**
 * The panel's view of a user's access tier (design D1-C).
 *
 * The full-tier roster is group membership, so this reuses the panel's own
 * membership check (`getChatMember`, five-minute positive cache, a 30-day
 * speaking fallback when the Bot API cannot answer). A rate-limited lookup makes
 * the tier trial rather than guessing.
 */
import { getToolConfig } from '../../config/tool-config.js';
import { accessTiersEnabled, getAccessGroupIds } from '../../config/trial-access.js';
import type { AccessTier } from '../../services/access-tier.js';
import { isUserAdmitted } from '../../services/user-access-cache.js';
import type { RequestAuth } from '../context.js';
import { MembershipUnavailableError } from './chat-access.js';

export const resolvePanelAccessTier = async (auth: RequestAuth): Promise<AccessTier> => {
    if (auth.user.isOwner) return 'owner';
    if (!accessTiersEnabled()) return 'full';
    // A positive TOOL_CHAT_IDS entry is a private chat, i.e. an explicitly listed user
    if (getToolConfig().toolChatIds.has(auth.user.id)) return 'full';
    if (isUserAdmitted(auth.user.id)) return 'full';
    for (const groupId of getAccessGroupIds()) {
        const access = await auth.access.resolve(groupId).catch((error: unknown) => {
            if (error instanceof MembershipUnavailableError) return null;
            throw error;
        });
        if (access === 'member') return 'full';
    }
    return 'trial';
};
