/**
 * GET /api/audit?chatId=&limit=&beforeId=: settings changes, newest first.
 * With chatId: that chat's changes, for its members and observers. Without:
 * every scope, owner only. `beforeId` pages backwards.
 */
import type { Hono } from 'hono';
import { chatAuditScope, listSettingsAudit } from '../../db/queries/settings-audit.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, requireOwner, type PanelEnv, type RequestAuth } from '../context.js';
import { parseChatId, parseOptionalPositiveInteger } from '../request.js';
import { toAuditEntryViews } from '../views/audit-view.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** The scope to list: a chat's after its access check, or every scope for the owner */
const auditScopeFor = async (auth: RequestAuth, rawChatId: string | undefined): Promise<string | undefined> => {
    if (rawChatId === undefined || rawChatId === '') {
        requireOwner(auth);
        return undefined;
    }
    const chatId = parseChatId(rawChatId);
    await requireChatAccess(auth, chatId);
    return chatAuditScope(chatId);
};

export const registerAuditRoute = (app: Hono<PanelEnv>): void => {
    app.get('/api/audit', async (context) => {
        const auth = requireAuth(context);
        const scope = await auditScopeFor(auth, context.req.query('chatId'));
        const limit = parseOptionalPositiveInteger(context.req.query('limit'), 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT;
        const beforeId = parseOptionalPositiveInteger(context.req.query('beforeId'), 'beforeId');

        const entries = await listSettingsAudit({
            ...(scope !== undefined ? { scope } : {}),
            limit,
            ...(beforeId !== undefined ? { beforeId } : {}),
        });
        return context.json({ entries: await toAuditEntryViews(entries) });
    });
};
