/**
 * POST /api/chats/:chatId/settings/preview
 * { promptAddendum?, promptTemplateIds?, promptTemplatesAuto? }: the runtime
 * block a reply in this chat would carry with the draft values, rendered with
 * the model the requester's next reply would actually use (a trial user is
 * pinned to the trial model; templates auto-load by that model, not the chat's
 * setting) and the requester as a sample roster (the real roster is built per
 * reply). Omitted keys fall back to the chat's saved values, so an old Mini App
 * that only sends `promptAddendum` still works. Stores nothing.
 *
 * `estimatedTokens` is an upper bound at 1.3 tokens per character.
 */
import type { Hono } from 'hono';
import { buildRuntimeContext } from '../../ai/system-prompt/runtime-context.js';
import type { ContextUser } from '../../ai/types.js';
import { resolveChatModel } from '../../config/chat-model.js';
import { effectiveReplyModel } from '../../services/access-tier.js';
import { normalizePromptAddendum } from '../../services/chat-settings-service.js';
import { normalizeTemplateIdList } from '../../services/prompt-template-ids.js';
import { resolveReplyAddendum } from '../../services/prompt-templates-service.js';
import { countCodePoints } from '../../shared/code-points.js';
import { resolvePanelAccessTier } from '../access/panel-tier.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { checkBodyKeys, invalid, parseChatId, readJsonObject } from '../request.js';
import type { PanelUser } from '../types.js';
import { currentChatSettings, runtimeChatTitleOf } from '../views/chat-view.js';

const PROMPT_ADDENDUM_KEY = 'promptAddendum';
const PROMPT_TEMPLATE_IDS_KEY = 'promptTemplateIds';
const PROMPT_TEMPLATES_AUTO_KEY = 'promptTemplatesAuto';
const DRAFT_KEYS: readonly string[] = [PROMPT_ADDENDUM_KEY, PROMPT_TEMPLATE_IDS_KEY, PROMPT_TEMPLATES_AUTO_KEY];
const ALLOWED_KEYS: ReadonlySet<string> = new Set(DRAFT_KEYS);
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
        const saved = currentChatSettings(chatId);

        const body = await readJsonObject(context);
        // Every draft key is optional: an empty body previews the saved values
        checkBodyKeys(body, ALLOWED_KEYS);

        const draftAddendum =
            Object.hasOwn(body, PROMPT_ADDENDUM_KEY)
                ? normalizePromptAddendum(body[PROMPT_ADDENDUM_KEY])
                : { ok: true as const, value: saved.promptAddendum };
        if (!draftAddendum.ok) throw invalid(draftAddendum.message);
        const draftTemplateIds =
            Object.hasOwn(body, PROMPT_TEMPLATE_IDS_KEY)
                ? normalizeTemplateIdList(body[PROMPT_TEMPLATE_IDS_KEY])
                : { ok: true as const, value: saved.promptTemplateIds };
        if (!draftTemplateIds.ok) throw invalid(draftTemplateIds.message);
        const rawAuto = body[PROMPT_TEMPLATES_AUTO_KEY];
        if (rawAuto !== undefined && typeof rawAuto !== 'boolean') {
            throw invalid(`${PROMPT_TEMPLATES_AUTO_KEY} 必须是布尔值`);
        }
        const draftAuto = typeof rawAuto === 'boolean' ? rawAuto : saved.promptTemplatesAuto;

        // The same model the requester's next reply would send, so auto-loaded
        // templates are shown against the model they would really see.
        const tier = await resolvePanelAccessTier(auth);
        const model = effectiveReplyModel(tier, resolveChatModel(chatId));
        const composed = await resolveReplyAddendum(
            chatId,
            { custom: draftAddendum.value, templateIds: draftTemplateIds.value, auto: draftAuto },
            model
        );

        const runtimeBlock = buildRuntimeContext(
            model,
            sampleRoster(auth.user),
            runtimeChatTitleOf(chat),
            composed.text
        );
        return context.json({
            runtimeBlock,
            appliedTemplates: composed.applied.map((template) => ({ id: template.id, name: template.name })),
            composedCodePoints: composed.text === null ? 0 : countCodePoints(composed.text),
            // Read by a Mini App tab opened before this release, which warns
            // "附加提示词不生效" when the flag is missing. Remove it next release.
            injected: true,
            estimatedTokens: estimateAddendumTokens(composed.text),
        });
    });
};
