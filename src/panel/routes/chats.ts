/**
 * GET /api/chats/:chatId: one chat's dashboard for members and observers —
 * settings, effective model, tool matrix and the latest settings changes.
 * `summary` (7-day reply metrics) arrives with reply_metrics in phase 3.
 */
import type { Hono } from 'hono';
import { resolveChatModel } from '../../config/chat-model.js';
import { chatAuditScope, listSettingsAudit } from '../../db/queries/settings-audit.js';
import { getGlobalDefaultModel } from '../../services/chat-settings-service.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { parseChatId } from '../request.js';
import { toAuditEntryViews, withoutScope } from '../views/audit-view.js';
import { currentChatSettings, toChatHeaderView, toSettingsView } from '../views/chat-view.js';
import { buildToolMatrix } from '../views/tool-matrix.js';

const RECENT_AUDIT_LIMIT = 5;

export const registerChatRoutes = (app: Hono<PanelEnv>): void => {
    app.get('/api/chats/:chatId', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const { chat, access } = await requireChatAccess(auth, chatId);

        const effectiveModel = resolveChatModel(chatId);
        const recentAudit = await listSettingsAudit({ scope: chatAuditScope(chatId), limit: RECENT_AUDIT_LIMIT });
        const recentAuditViews = await toAuditEntryViews(recentAudit);

        return context.json({
            chat: toChatHeaderView(chat, access),
            settings: toSettingsView(currentChatSettings(chatId)),
            effectiveModel,
            globalDefaultModel: getGlobalDefaultModel(),
            tools: buildToolMatrix(effectiveModel, chatId),
            summary: null,
            recentAudit: recentAuditViews.map(withoutScope),
        });
    });
};
