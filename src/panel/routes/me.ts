/**
 * GET /api/me: who is asking, their access tier, the chats they can open, and
 * where the signed start_param wants them to land.
 */
import type { Hono } from 'hono';
import { listModelCatalog } from '../../config/model-catalog.js';
import { accessTiersEnabled, getAccessGroupIds, TRIAL_MODEL } from '../../config/trial-access.js';
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import { findChat } from '../../db/queries/panel-registry.js';
import { getGlobalDefaultModel } from '../../services/chat-settings-service.js';
import { latestApplicationOf, type LatestApplicationSummary } from '../../services/user-access-cache.js';
import { countPendingApplications } from '../../services/user-access-service.js';
import { listAccessibleChats } from '../access/chat-access.js';
import { resolvePanelAccessTier } from '../access/panel-tier.js';
import { parseStartParam, resolveHintChatId } from '../auth/start-param.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { countOpenIssuesByChat, findIssueChatId } from '../queries/harness-issues.js';
import { toChatListItem } from '../views/chat-list.js';
import { buildStartTarget } from '../views/start-target.js';

/** A reply deep link only lands on the reply while it is stored */
const replyExists = async (chatId: number, firstMessageId: number): Promise<boolean> =>
    (await findBotResponseInChat(chatId, firstMessageId)) !== null;

/** The groups whose members are automatically full, as the owner's review page explains them */
const accessGroupsOf = async (): Promise<{ chatId: number; title: string | null }[]> => {
    const chatIds = [...getAccessGroupIds()];
    const rows = await Promise.all(chatIds.map((chatId) => findChat(chatId)));
    return chatIds.map((chatId, index) => ({ chatId, title: rows[index]?.title ?? null }));
};

/** The requester's own latest application: the review internals stay private */
const toAccessApplicationSelf = (summary: LatestApplicationSummary | null) => {
    if (summary === null) return null;
    return {
        id: summary.id,
        userId: summary.userId,
        status: summary.status,
        comment: summary.comment,
        createdAt: summary.createdAt.toISOString(),
    };
};

export const registerMeRoute = (app: Hono<PanelEnv>): void => {
    app.get('/api/me', async (context) => {
        const auth = requireAuth(context);
        const target = parseStartParam(auth.startParam);
        const hintChatId = await resolveHintChatId(target, findIssueChatId);
        const [accessibleChats, openIssuesByChat, pendingAccessApplications, accessTier, accessGroups] =
            await Promise.all([
                listAccessibleChats(auth.access, hintChatId),
                countOpenIssuesByChat(),
                // The review badge is the owner's alone; everyone else gets null
                auth.user.isOwner ? countPendingApplications() : Promise.resolve(null),
                resolvePanelAccessTier(auth),
                // Who is in the roster is the owner's business; everyone else gets null
                auth.user.isOwner ? accessGroupsOf() : Promise.resolve(null),
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
            // The catalog registry (DB-backed once loaded): an allowed model
            // enters the menu without a release (design §P6)
            models: listModelCatalog().map((model) => model.id),
            chats: accessibleChats.map((accessible) => toChatListItem(accessible, openIssuesByChat)),
            startTarget,
            accessTier,
            accessGroups,
            trialModel: TRIAL_MODEL,
            accessTieringEnabled: accessTiersEnabled(),
            accessApplication: toAccessApplicationSelf(latestApplicationOf(auth.user.id)),
            pendingAccessApplications,
        });
    });
};
