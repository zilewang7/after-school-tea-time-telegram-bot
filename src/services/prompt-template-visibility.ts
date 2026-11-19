/**
 * Who may see a prompt template and which templates a chat may auto-load: the
 * visibility rules of design D2/D3 as pure functions shared by the panel and the
 * reply path, plus the one member lookup the automatic candidates need.
 *
 * Visibility only decides who may see and enable a template in the panel. A
 * template a chat already enabled keeps loading after the author makes it
 * private (design D2): the author stops it with the template's own switch.
 */
import { isOwnerUser } from '../config/owner.js';
import { ChatMemberSeen } from '../db/chatMemberSeenDTO.js';
import type { PromptTemplate } from './prompt-templates-cache.js';

export interface TemplateVisibilityContext {
    readonly viewerId: number;
    /** The owner sees every template, in the panel and in every chat's list */
    readonly isOwner: boolean;
    /** Members of the chat the list is for (private chat: the user themselves) */
    readonly knownMemberIds: ReadonlySet<number>;
}

/** The two ids the automatic candidates compare against */
export interface AutoCandidateContext {
    readonly ownerId: number;
    readonly knownMemberIds: ReadonlySet<number>;
}

/**
 * D2: the owner sees every template; a creator sees their own; `private` is
 * otherwise hidden; a `group` template is visible where its creator is a known
 * member of the chat, and the owner's group templates are visible everywhere.
 */
export const isTemplateVisible = (template: PromptTemplate, context: TemplateVisibilityContext): boolean => {
    if (context.isOwner) return true;
    if (template.createdBy === context.viewerId) return true;
    if (template.visibility === 'private') return false;
    if (isOwnerUser(template.createdBy)) return true;
    return context.knownMemberIds.has(template.createdBy);
};

/**
 * D3 rule 2 without the model rule (composeChatAddendum applies that): an
 * enabled group template created by the owner or by a known member of the chat.
 */
export const isAutoCandidate = (template: PromptTemplate, context: AutoCandidateContext): boolean => {
    if (!template.enabled || template.visibility !== 'group') return false;
    return template.createdBy === context.ownerId || context.knownMemberIds.has(template.createdBy);
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
