/**
 * Who may see a prompt template and which templates a chat may auto-load: the
 * visibility rules of design 2026-1119-1740 §变更1 as pure functions shared by
 * the panel and the reply path, plus the one member lookup the automatic
 * candidates need.
 *
 * A private template exists only inside a private chat: it is not listed in a
 * group for anyone, the owner included, and composition skips it there even
 * when an old chat settings row still enables it.
 */
import { isOwnerUser } from '../config/owner.js';
import { ChatMemberSeen } from '../db/chatMemberSeenDTO.js';
import type { PromptTemplate } from './prompt-templates-cache.js';

// The candidate rule itself is pure, so it lives with the other template rules;
// composition imports it there and this module keeps the panel's import path.
export { isAutoCandidate } from './prompt-template-rules.js';
export type { AutoCandidateContext } from './prompt-template-rules.js';

export interface TemplateVisibilityContext {
    readonly viewerId: number;
    /** The owner sees every template in the management list and every non-private one here */
    readonly isOwner: boolean;
    /** Members of the chat the list is for (private chat: the user themselves) */
    readonly knownMemberIds: ReadonlySet<number>;
    /** The chat is a private chat: the only place a private template is listed */
    readonly isPrivateChat: boolean;
}

/**
 * §变更1 matrix: `private` is listed only in a private chat, to its creator or
 * the owner. Otherwise the owner sees every template, a creator sees their own,
 * `global` is visible to everyone, and `group` is visible where its creator is a
 * known member of the chat. The owner's group templates are a public library:
 * they are visible in every chat, private chats included, like `global`.
 */
export const isTemplateVisible = (template: PromptTemplate, context: TemplateVisibilityContext): boolean => {
    const isOwnTemplate = template.createdBy === context.viewerId;
    if (template.visibility === 'private') {
        return context.isPrivateChat && (isOwnTemplate || context.isOwner);
    }
    if (context.isOwner || isOwnTemplate) return true;
    if (template.visibility === 'global') return true;
    // The owner's group templates are the public library (visible in every chat,
    // other users' private chats included)
    if (isOwnerUser(template.createdBy)) return true;
    // Otherwise the creator must be a known member of this chat; a private
    // chat's set is the viewer alone, so another member's template stops here
    return context.knownMemberIds.has(template.createdBy);
};

/**
 * The chat's known members: a group reads `chat_members_seen` (the people the
 * bot has seen speak or join, a lower bound on membership); a private chat is
 * just its user. Called only when the auto switch is on, never per template.
 */
export const loadKnownChatMemberIds = async (chatId: number): Promise<ReadonlySet<number>> => {
    if (chatId > 0) return new Set([chatId]);
    const rows = await ChatMemberSeen.findAll({ where: { chatId }, attributes: ['userId'] });
    return new Set(rows.map((row) => row.userId));
};
