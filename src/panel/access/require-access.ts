/**
 * The access gate of every single-chat endpoint: member or observer passes,
 * anyone else gets the same 403 whether or not the chat exists, and a
 * rate-limited membership lookup is a 503.
 */
import { findChat, type ChatRow } from '../../db/queries/panel-registry.js';
import type { RequestAuth } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';
import type { VisibleAccess } from '../types.js';
import { MembershipUnavailableError } from './chat-access.js';

export interface GrantedChat {
    chat: ChatRow;
    access: VisibleAccess;
}

export const requireChatAccess = async (auth: RequestAuth, chatId: number): Promise<GrantedChat> => {
    const access = await auth.access.resolve(chatId).catch((error: unknown) => {
        if (error instanceof MembershipUnavailableError) {
            throw new PanelError('internal', PANEL_MESSAGES.membershipUnavailable, { status: 503 });
        }
        throw error;
    });
    if (access === 'none') throw new PanelError('forbidden', PANEL_MESSAGES.forbidden);
    const chat = await findChat(chatId);
    // Access implies a row (resolveChatAccess creates the private one); refuse rather than guess
    if (chat === null) throw new PanelError('forbidden', PANEL_MESSAGES.forbidden);
    return { chat, access };
};
