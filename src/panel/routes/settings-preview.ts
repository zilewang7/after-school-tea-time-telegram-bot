/**
 * POST /api/chats/:chatId/settings/preview { promptAddendum }: the runtime
 * block a reply in this chat would carry with that addendum, rendered with the
 * chat's current model and the requester as a sample roster (the real roster
 * is built per reply). Stores nothing, so it keeps the 24h read window.
 *
 * `estimatedTokens` is an upper bound at 1.3 tokens per character.
 */
import type { Hono } from 'hono';
import { buildRuntimeContext } from '../../ai/system-prompt/runtime-context.js';
import type { ContextUser } from '../../ai/types.js';
import { resolveChatModel } from '../../config/chat-model.js';
import { normalizePromptAddendum } from '../../services/chat-settings-service.js';
import { countCodePoints } from '../../services/chat-settings-service.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { checkBodyKeys, invalid, parseChatId, readJsonObject } from '../request.js';
import type { PanelUser } from '../types.js';
import { runtimeChatTitleOf } from '../views/chat-view.js';

const PROMPT_ADDENDUM_KEY = 'promptAddendum';
const ALLOWED_KEYS: ReadonlySet<string> = new Set([PROMPT_ADDENDUM_KEY]);
const TOKENS_PER_CHARACTER_UPPER_BOUND = 1.3;

const sampleRoster = (user: PanelUser): ContextUser[] => [
    {
        userId: user.id,
        firstName: user.firstName,
        ...(user.lastName !== null ? { lastName: user.lastName } : {}),
        ...(user.username !== null ? { username: user.username } : {}),
        mentionedOnly: false,
    },
];

export const estimateAddendumTokens = (addendum: string | null): number =>
    addendum === null ? 0 : Math.ceil(countCodePoints(addendum) * TOKENS_PER_CHARACTER_UPPER_BOUND);

export const registerSettingsPreviewRoute = (app: Hono<PanelEnv>): void => {
    app.post('/api/chats/:chatId/settings/preview', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const { chat } = await requireChatAccess(auth, chatId);

        const body = await readJsonObject(context);
        checkBodyKeys(body, ALLOWED_KEYS, [PROMPT_ADDENDUM_KEY]);
        const normalized = normalizePromptAddendum(body[PROMPT_ADDENDUM_KEY]);
        if (!normalized.ok) throw invalid(normalized.message);

        const runtimeBlock = buildRuntimeContext(
            resolveChatModel(chatId),
            sampleRoster(auth.user),
            runtimeChatTitleOf(chat),
            normalized.value
        );
        return context.json({
            runtimeBlock,
            // Read by a Mini App tab opened before this release, which warns
            // "附加提示词不生效" when the flag is missing. Remove it next release.
            injected: true,
            estimatedTokens: estimateAddendumTokens(normalized.value),
        });
    });
};
