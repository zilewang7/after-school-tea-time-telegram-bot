/**
 * PUT / DELETE /api/chats/:chatId/messages/:messageId/exclusion — members
 * only: take a message out of the model's context for the whole chat, or put
 * it back (design §6.2 排除的语义).
 *
 * The id is normalized first: a continuation message of a bot reply becomes
 * the reply's first message. A message we do not have is a 404; an album's
 * sub-image is a 400 (excluding the album's first message takes the whole
 * album out). Repeating either write answers 200 and audits nothing.
 */
import type { Hono } from 'hono';
import { findBotResponseByMessageId } from '../../db/index.js';
import { excludeMessage, includeMessage } from '../../db/queries/context-exclusions.js';
import { getContextMessage } from '../../db/queries/context-queries.js';
import { isSubImage } from '../../reply/context-assembly.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelContext, type PanelEnv } from '../context.js';
import { PanelError } from '../errors.js';
import { invalid, parseChatId } from '../request.js';
import { CONVERSATION_MESSAGES, parseMessageIdParam, requireMember } from './conversation-params.js';

export interface ExcludedMessageView {
    messageId: number;
    excluded: true;
    createdAt: string;
    createdBy: number;
}

export interface IncludedMessageView {
    messageId: number;
    excluded: false;
}

/** The id an exclusion is stored under; 404 / 400 for what cannot be excluded */
const canonicalExclusionId = async (chatId: number, messageId: number): Promise<number> => {
    const reply = await findBotResponseByMessageId(chatId, messageId);
    const canonicalId = reply?.messageId ?? messageId;
    const message = await getContextMessage(chatId, canonicalId);
    if (message === null) throw new PanelError('not_found', CONVERSATION_MESSAGES.messageNotFound);
    if (isSubImage(message)) {
        throw invalid('相册里的单张图片不能单独排除，请排除相册的第一条消息（整组图片会一起离开上下文）');
    }
    return canonicalId;
};

/** Access, member gate and the normalized target of one exclusion request */
const readExclusionRequest = async (
    context: PanelContext
): Promise<{ chatId: number; messageId: number; actorId: number }> => {
    const auth = requireAuth(context);
    const chatId = parseChatId(context.req.param('chatId'));
    requireMember(await requireChatAccess(auth, chatId));
    const requestedId = parseMessageIdParam(context.req.param('messageId'), 'messageId');
    return { chatId, messageId: await canonicalExclusionId(chatId, requestedId), actorId: auth.user.id };
};

export const registerExclusionRoutes = (app: Hono<PanelEnv>): void => {
    app.put('/api/chats/:chatId/messages/:messageId/exclusion', async (context) => {
        const target = await readExclusionRequest(context);
        const { row } = await excludeMessage(target);
        const view: ExcludedMessageView = {
            messageId: row.messageId,
            excluded: true,
            createdAt: row.createdAt.toISOString(),
            createdBy: row.createdBy,
        };
        return context.json(view);
    });

    app.delete('/api/chats/:chatId/messages/:messageId/exclusion', async (context) => {
        const target = await readExclusionRequest(context);
        await includeMessage(target);
        const view: IncludedMessageView = { messageId: target.messageId, excluded: false };
        return context.json(view);
    });
};
