/**
 * The bot owner's identity as a number. OWNER_USER_ID reaches the tool config
 * as a string; only a plain digit string counts, anything else means "no
 * owner" (an authorization decision never guesses at a malformed id).
 */
import { getToolConfig } from './tool-config.js';

const PLAIN_DIGITS = /^\d+$/;

/** null when OWNER_USER_ID is unset or not a plain number */
export const getOwnerUserId = (): number | null => {
    const raw = getToolConfig().owner.userId;
    if (raw === null || !PLAIN_DIGITS.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

export const isOwnerUser = (userId: number): boolean => {
    const ownerUserId = getOwnerUserId();
    return ownerUserId !== null && ownerUserId === userId;
};
