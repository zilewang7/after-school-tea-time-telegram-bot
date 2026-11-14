/**
 * GET /api/chats/:chatId/conversations/:rootId/model-view?at=&asModel= —
 * members only. What the model would see if retry were pressed now on a reply
 * of this conversation (views/model-view.ts). `asModel` (same rule as the
 * model setting: any trimmed id up to 64 characters, no image model) only
 * changes this view.
 * The response is capped at 2 MB.
 */
import type { Hono } from 'hono';
import { normalizeModelId } from '../../services/chat-settings-rules.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { invalid, parseChatId, parseOptionalPositiveInteger } from '../request.js';
import { buildModelView } from '../views/model-view.js';
import { jsonWithinLimit, type ConversationRouteDeps } from './conversation-deps.js';
import { parseMessageIdParam, requireConversationRoot, requireMember } from './conversation-params.js';

const MODEL_VIEW_MAX_BYTES = 2 * 1024 * 1024;

const parseAsModel = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const normalized = normalizeModelId(raw);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value ?? undefined;
};

export const registerModelViewRoute = (app: Hono<PanelEnv>, deps: ConversationRouteDeps): void => {
    app.get('/api/chats/:chatId/conversations/:rootId/model-view', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const granted = await requireChatAccess(auth, chatId);
        requireMember(granted);

        const rootId = parseMessageIdParam(context.req.param('rootId'), 'rootId');
        const at = parseOptionalPositiveInteger(context.req.query('at'), 'at');
        const asModel = parseAsModel(context.req.query('asModel'));
        await requireConversationRoot(chatId, rootId);

        const view = await buildModelView({
            chat: granted.chat,
            rootId,
            at,
            asModel,
            toolApi: deps.toolApi,
            now: new Date(deps.now()),
        });
        return jsonWithinLimit(context, view, MODEL_VIEW_MAX_BYTES, '模型视角超过 2 MB，无法显示');
    });
};
