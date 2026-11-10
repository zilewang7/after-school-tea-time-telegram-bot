/**
 * GET /api/chats/:chatId/replies/:firstMessageId — every version of one bot
 * reply, read-only, for members and observers (observers never get
 * triggerUserId). A reply of another chat that happens to share the id is a
 * 404, never served across chats.
 *
 * Each version's widget carries short-lived signed iframe URLs (design §5.5);
 * the signer is built by the app from BOT_TOKEN, so this route only needs it
 * handed in.
 */
import type { Hono } from 'hono';
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { PanelError } from '../errors.js';
import { parseChatId } from '../request.js';
import { findActiveReplyShareUrls } from '../share/share-link-service.js';
import type { SignedMediaSigner } from '../share/signed-media.js';
import type { SignedWidgetSigner } from '../share/signed-widget.js';
import { buildReplyDetailView } from '../views/reply-view.js';
import { CONVERSATION_MESSAGES, parseMessageIdParam } from './conversation-params.js';

export interface ReplyRouteOptions {
    signer: SignedWidgetSigner;
    /** Signs the `/m/…` URLs of the versions' media */
    mediaSigner: SignedMediaSigner;
}

export const registerReplyRoute = (app: Hono<PanelEnv>, options: ReplyRouteOptions): void => {
    app.get('/api/chats/:chatId/replies/:firstMessageId', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const { access } = await requireChatAccess(auth, chatId);

        const firstMessageId = parseMessageIdParam(context.req.param('firstMessageId'), 'firstMessageId');
        const response = await findBotResponseInChat(chatId, firstMessageId);
        if (response === null) throw new PanelError('not_found', CONVERSATION_MESSAGES.replyNotFound);
        const shareUrlsByVersion = await findActiveReplyShareUrls(chatId, firstMessageId);
        return context.json(
            await buildReplyDetailView(response, access, {
                signer: options.signer,
                mediaSigner: options.mediaSigner,
                shareUrlsByVersion,
            })
        );
    });
};
