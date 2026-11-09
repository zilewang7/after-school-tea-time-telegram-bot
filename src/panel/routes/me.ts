/**
 * GET /api/me: who is asking, the chats they can open, and where the signed
 * start_param wants them to land.
 */
import type { Hono } from 'hono';
import { modelConfigs } from '../../config/models.js';
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import { getGlobalDefaultModel } from '../../services/chat-settings-service.js';
import { listAccessibleChats } from '../access/chat-access.js';
import { parseStartParam, resolveHintChatId } from '../auth/start-param.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { countOpenIssuesByChat, findIssueChatId } from '../queries/harness-issues.js';
import { toChatListItem } from '../views/chat-list.js';
import { buildStartTarget } from '../views/start-target.js';

/** A reply deep link only lands on the reply while it is stored */
const replyExists = async (chatId: number, firstMessageId: number): Promise<boolean> =>
    (await findBotResponseInChat(chatId, firstMessageId)) !== null;

export const registerMeRoute = (app: Hono<PanelEnv>): void => {
    app.get('/api/me', async (context) => {
        const auth = requireAuth(context);
        const target = parseStartParam(auth.startParam);
        const hintChatId = await resolveHintChatId(target, findIssueChatId);
        const [accessibleChats, openIssuesByChat] = await Promise.all([
            listAccessibleChats(auth.access, hintChatId),
            countOpenIssuesByChat(),
        ]);
        const startTarget = await buildStartTarget(target, hintChatId, auth.access, replyExists);

        return context.json({
            user: {
                id: auth.user.id,
                firstName: auth.user.firstName,
                lastName: auth.user.lastName,
                username: auth.user.username,
            },
            isOwner: auth.user.isOwner,
            authenticatedBy: auth.authenticatedBy,
            globalDefaultModel: getGlobalDefaultModel(),
            // Read per request: the menu list is not frozen at startup
            models: modelConfigs.map((model) => model.id),
            chats: accessibleChats.map((accessible) => toChatListItem(accessible, openIssuesByChat)),
            startTarget,
        });
    });
};
