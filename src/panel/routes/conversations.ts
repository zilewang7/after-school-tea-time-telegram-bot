/**
 * GET /api/chats/:chatId/conversations?before=&limit= — the conversation list.
 * GET /api/chats/:chatId/conversations/:rootId — one conversation's tree.
 * GET /api/chats/:chatId/conversations/:rootId/stats — that tree's statistics.
 *
 * Members and observers; observers get user messages as placeholders (the
 * server decides, design §6.2). Read-only: no backfill, no media bytes.
 */
import type { Hono } from 'hono';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { invalid, parseChatId, parseOptionalPositiveInteger } from '../request.js';
import { buildConversationStats } from '../stats/build-conversation-stats.js';
import { buildConversationListView, parseConversationCursor } from '../views/conversation-list.js';
import { buildConversationTreeView } from '../views/conversation-tree.js';
import type { ConversationRouteDeps } from './conversation-deps.js';
import { parseMessageIdParam, requireConversationRoot } from './conversation-params.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const parseBefore = (raw: string | undefined) => {
    if (raw === undefined || raw === '') return null;
    const cursor = parseConversationCursor(raw);
    if (cursor === null) throw invalid('before 游标格式不正确');
    return cursor;
};

export const registerConversationRoutes = (app: Hono<PanelEnv>, deps: ConversationRouteDeps): void => {
    app.get('/api/chats/:chatId/conversations', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const { access } = await requireChatAccess(auth, chatId);

        const limit = parseOptionalPositiveInteger(context.req.query('limit'), 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT;
        const before = parseBefore(context.req.query('before'));
        return context.json(
            await buildConversationListView({ chatId, access, limit, before, now: new Date(deps.now()) })
        );
    });

    app.get('/api/chats/:chatId/conversations/:rootId', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const { chat, access } = await requireChatAccess(auth, chatId);

        const rootId = parseMessageIdParam(context.req.param('rootId'), 'rootId');
        await requireConversationRoot(chatId, rootId);
        return context.json({
            access,
            ...(await buildConversationTreeView(chat, access, rootId, { mediaSigner: deps.mediaSigner })),
        });
    });

    app.get('/api/chats/:chatId/conversations/:rootId/stats', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        await requireChatAccess(auth, chatId);

        const rootId = parseMessageIdParam(context.req.param('rootId'), 'rootId');
        await requireConversationRoot(chatId, rootId);
        return context.json(
            await buildConversationStats(chatId, rootId, new Date(deps.now()), auth.user.isOwner)
        );
    });
};
