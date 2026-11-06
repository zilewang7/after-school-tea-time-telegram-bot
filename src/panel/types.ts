/**
 * Shapes shared across the panel's modules.
 */

/** The verified requester, from initData plus the owner check */
export interface PanelUser {
    id: number;
    firstName: string;
    lastName: string | null;
    username: string | null;
    isOwner: boolean;
}

/**
 * What a user may do with one chat: `member` (group member, or the private
 * chat's own user; the owner too when a member), `observer` (only the owner,
 * where not a member: sees bot output only), `none`.
 */
export type ChatAccess = 'none' | 'observer' | 'member';

/** The access levels that make a chat visible */
export type VisibleAccess = Exclude<ChatAccess, 'none'>;
