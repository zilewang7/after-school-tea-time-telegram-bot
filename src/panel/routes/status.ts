/**
 * GET /api/status: live state for any verified user, polled every 5s by the
 * status pages (design §6.6). Process facts for the owner only; replies being
 * generated and recent errors only for chats the requester may see. The
 * all-chats page and a chat's own page use the same answer, the front end
 * filters by chatId. Shape: views/status-view.ts.
 */
import type { Hono } from 'hono';
import { listChats, type ChatRow } from '../../db/queries/panel-registry.js';
import { listActiveSessions, type BotMessageSession } from '../../services/bot-message-service.js';
import { priceWatchStatus } from '../../services/model-price-service.js';
import { listRecentReplyErrors } from '../../services/recent-reply-errors.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { findTriggerSummary, type TriggerSummary } from '../queries/trigger-messages.js';
import type { VisibleAccess } from '../types.js';
import {
    buildProcessStatus,
    toActiveReplyView,
    toStatusChatView,
    toStatusErrorView,
    type ProcessPricingView,
    type StatusChatView,
    type StatusResponse,
} from '../views/status-view.js';
import { resolveStatusAccess } from './status-access.js';

export interface StatusRouteInfo {
    readonly startedAt: Date;
    /** Short commit hash; null when unknown */
    readonly version: string | null;
}

/** Observers never get the trigger read at all */
const triggerFor = (session: BotMessageSession, access: VisibleAccess): Promise<TriggerSummary | null> =>
    access === 'member' ? findTriggerSummary(session.chatId, session.userMessageId) : Promise.resolve(null);

/**
 * The watcher's facts are DB state: reading them must not break /api/status,
 * so an unavailable watcher leaves the block null.
 */
const pricingStatusOrNull = async (): Promise<ProcessPricingView | null> => {
    try {
        const status = await priceWatchStatus();
        return {
            version: status.version,
            lastRunAt: status.lastRunAt,
            lastOutcome: status.lastOutcome,
            pendingProposals: status.pendingProposals,
        };
    } catch (error: unknown) {
        console.warn('[panel] price watch status unavailable:', error);
        return null;
    }
};

export const registerStatusRoute = (app: Hono<PanelEnv>, info: StatusRouteInfo): void => {
    app.get('/api/status', async (context) => {
        const auth = requireAuth(context);
        const now = new Date();
        const sessions = listActiveSessions();
        const errors = listRecentReplyErrors();
        const accessByChat = await resolveStatusAccess(
            auth,
            new Set([...sessions.map((session) => session.chatId), ...errors.map((entry) => entry.chatId)])
        );
        const chats: ReadonlyMap<number, ChatRow> =
            accessByChat.size === 0 ? new Map() : new Map((await listChats()).map((chat) => [chat.chatId, chat]));
        const chatView = (chatId: number): StatusChatView => toStatusChatView(chatId, chats.get(chatId));

        const visibleSessions = sessions
            .flatMap((session) => {
                const access = accessByChat.get(session.chatId);
                return access === undefined ? [] : [{ session, access }];
            })
            .sort((first, second) => first.session.metrics.startedAt.getTime() - second.session.metrics.startedAt.getTime());
        const active = await Promise.all(
            visibleSessions.map(async ({ session, access }) =>
                toActiveReplyView({
                    session,
                    chat: chatView(session.chatId),
                    access,
                    trigger: await triggerFor(session, access),
                    now,
                })
            )
        );
        const recentErrors = errors.flatMap((entry) => {
            const access = accessByChat.get(entry.chatId);
            return access === undefined ? [] : [toStatusErrorView(entry, chatView(entry.chatId), access)];
        });

        const body: StatusResponse = {
            serverTime: now.toISOString(),
            process: auth.user.isOwner ? buildProcessStatus(info, now, await pricingStatusOrNull()) : null,
            active,
            recentErrors,
        };
        return context.json(body);
    });
};
