/**
 * The panel user behind a web session (design §6.3).
 *
 * A session only carries the user id; the display name comes from the same
 * roster that initData users write to. A user the bot has never seen keeps a
 * placeholder name — the permission model does not depend on it.
 */
import { isOwnerUser } from '../../config/owner.js';
import { findTelegramUsersByIds } from '../../db/queries/user-queries.js';
import type { PanelUser } from '../types.js';

export const panelUserOfWebSession = async (userId: number): Promise<PanelUser> => {
    const [row] = await findTelegramUsersByIds([userId]);
    if (row === undefined) {
        return {
            id: userId,
            firstName: `用户${userId}`,
            lastName: null,
            username: null,
            isOwner: isOwnerUser(userId),
        };
    }
    return {
        id: userId,
        firstName: row.firstName,
        lastName: row.lastName ?? null,
        username: row.username ?? null,
        isOwner: isOwnerUser(userId),
    };
};
