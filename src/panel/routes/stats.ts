/**
 * GET /api/stats?chatId=&range=: reply statistics and cost estimates from
 * reply_metrics (design §6.5). With chatId: that chat, for its members and
 * observers; the response carries no user id or display name for either.
 * Without: every chat, owner only. range: 24h | 7d (default) | 30d | 90d |
 * all; hourly buckets for 24h, daily otherwise. Shape: views/stats-view.ts.
 */
import type { Hono } from 'hono';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, requireOwner, type PanelEnv, type RequestAuth } from '../context.js';
import { invalid, parseChatId } from '../request.js';
import { buildStats } from '../stats/build-stats.js';
import { parseStatsRange, STATS_RANGE_KEYS } from '../stats/stats-window.js';

/** The chat to report on after its access check, or null (every chat) for the owner */
const statsScopeFor = async (auth: RequestAuth, rawChatId: string | undefined): Promise<number | null> => {
    if (rawChatId === undefined || rawChatId === '') {
        requireOwner(auth);
        return null;
    }
    const chatId = parseChatId(rawChatId);
    await requireChatAccess(auth, chatId);
    return chatId;
};

export const registerStatsRoute = (app: Hono<PanelEnv>): void => {
    app.get('/api/stats', async (context) => {
        const auth = requireAuth(context);
        const chatId = await statsScopeFor(auth, context.req.query('chatId'));
        const range = parseStatsRange(context.req.query('range'));
        if (range === null) throw invalid(`range 必须是 ${STATS_RANGE_KEYS.join(' / ')} 之一`);
        return context.json(
            await buildStats({ chatId, range, now: new Date(), isOwner: auth.user.isOwner })
        );
    });
};
