/**
 * Prompt templates: user-owned prompt blocks that a chat enables itself, plus
 * the per-chat list the session settings page reads.
 *
 * - Management list: the owner sees every template; everyone else sees the ones
 *   they created (they are the only ones who may edit them).
 * - `GET /api/chats/:chatId/prompt-templates`: templates visible in that chat
 *   (design 2026-1119-1740 §变更1: a private template is listed in private chats
 *   only), each with whether the chat manually enables it and whether the
 *   session's auto switch would load it for the viewer's model.
 * - Create: any authenticated panel user. Update/delete: the creator or the bot
 *   owner. The service re-checks ownership under its write queue.
 */
import type { Hono } from 'hono';
import { resolveChatModel } from '../../services/chat-model.js';
import { getOwnerUserId } from '../../config/owner.js';
import { effectiveReplyModel } from '../../services/access-tier.js';
import { defaultChatSettings, getChatSettings } from '../../services/chat-settings-service.js';
import {
    countChatsUsingTemplate,
    getPromptTemplate,
    listPromptTemplates,
    type PromptTemplate,
} from '../../services/prompt-templates-cache.js';
import { templateMatchesModel, type PromptTemplateVisibility } from '../../services/prompt-template-rules.js';
import {
    isAutoCandidate,
    isTemplateVisible,
    loadKnownChatMemberIds,
} from '../../services/prompt-template-visibility.js';
import {
    createPromptTemplate,
    deletePromptTemplate,
    updatePromptTemplate,
} from '../../services/prompt-templates-service.js';
import { resolvePanelAccessTier } from '../access/panel-tier.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv, type RequestAuth } from '../context.js';
import { PanelError } from '../errors.js';
import { invalid, parseChatId, readJsonObject } from '../request.js';
import { displayNameOf, lookupDisplayNames, type DisplayNames } from '../views/display-names.js';
import { rethrowSettingsError } from './settings-errors.js';
import { parsePromptTemplateCreateBody, parsePromptTemplatePatchBody } from './prompt-templates-body.js';

const PREVIEW_CODE_POINTS = 120;
const TEMPLATE_ID_PATTERN = /^\d{1,15}$/;
const NOT_FOUND_MESSAGE = '模板不存在';
const NOT_OWNER_MESSAGE = '只有创建者或机主可以修改该模板';

/** One template as the management list shows it: no full content */
export interface PromptTemplateItemView {
    id: number;
    name: string;
    contentLength: number;
    contentPreview: string;
    modelPatterns: readonly string[];
    sortOrder: number;
    visibility: PromptTemplateVisibility;
    enabled: boolean;
    createdBy: number;
    createdByName: string;
    chatCount: number;
    updatedAt: string;
}

/** A template as its own page shows it */
export interface PromptTemplateDetailView extends PromptTemplateItemView {
    content: string;
    createdAt: string;
}

/** One entry of a chat's template list */
export interface ChatPromptTemplateView extends PromptTemplateItemView {
    /** The whole content: the session row expands it, so it shows no second truncation */
    content: string;
    /** The chat manually enables it (loads regardless of the model) */
    enabledInChat: boolean;
    /** The session auto switch would load it for the viewer's model */
    autoMatchesViewerModel: boolean;
}

const contentPreviewOf = (content: string): string => {
    const characters = Array.from(content);
    if (characters.length <= PREVIEW_CODE_POINTS) return content;
    return `${characters.slice(0, PREVIEW_CODE_POINTS).join('')}…`;
};

const itemViewOf = (template: PromptTemplate, names: DisplayNames): PromptTemplateItemView => ({
    id: template.id,
    name: template.name,
    contentLength: Array.from(template.content).length,
    contentPreview: contentPreviewOf(template.content),
    modelPatterns: template.modelPatterns,
    sortOrder: template.sortOrder,
    visibility: template.visibility,
    enabled: template.enabled,
    createdBy: template.createdBy,
    createdByName: displayNameOf(names, template.createdBy),
    chatCount: countChatsUsingTemplate(template.id),
    updatedAt: template.updatedAt.toISOString(),
});

const detailViewOf = (template: PromptTemplate, names: DisplayNames): PromptTemplateDetailView => ({
    ...itemViewOf(template, names),
    content: template.content,
    createdAt: template.createdAt.toISOString(),
});

const parseTemplateId = (raw: string | undefined): number => {
    if (raw === undefined || !TEMPLATE_ID_PATTERN.test(raw)) throw invalid('模板 id 不合法');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw invalid('模板 id 不合法');
    return value;
};

/** The template with its creator's display name, or a 404 */
const templateOf = async (templateId: number): Promise<{ template: PromptTemplate; names: DisplayNames }> => {
    const template = getPromptTemplate(templateId);
    if (template === undefined) throw new PanelError('not_found', NOT_FOUND_MESSAGE);
    const names = await lookupDisplayNames([template.createdBy]);
    return { template, names };
};

/** A write is allowed for the creator and the bot owner only */
const requireTemplateOwner = (auth: RequestAuth, template: PromptTemplate): void => {
    if (auth.user.isOwner || template.createdBy === auth.user.id) return;
    throw new PanelError('forbidden', NOT_OWNER_MESSAGE);
};

export const registerPromptTemplateRoutes = (app: Hono<PanelEnv>): void => {
    app.get('/api/prompt-templates', async (context) => {
        const auth = requireAuth(context);
        const templates = auth.user.isOwner
            ? listPromptTemplates()
            : listPromptTemplates().filter((template) => template.createdBy === auth.user.id);
        const names = await lookupDisplayNames(templates.map((template) => template.createdBy));
        return context.json({ templates: templates.map((template) => itemViewOf(template, names)) });
    });

    app.get('/api/prompt-templates/:id', async (context) => {
        const auth = requireAuth(context);
        const templateId = parseTemplateId(context.req.param('id'));
        const { template, names } = await templateOf(templateId);
        if (!auth.user.isOwner && template.createdBy !== auth.user.id) {
            throw new PanelError('forbidden', NOT_OWNER_MESSAGE);
        }
        return context.json({ template: detailViewOf(template, names) });
    });

    app.post('/api/prompt-templates', async (context) => {
        const auth = requireAuth(context);
        const input = parsePromptTemplateCreateBody(await readJsonObject(context));
        const template = await createPromptTemplate(input, {
            userId: auth.user.id,
            isOwner: auth.user.isOwner,
        }).catch(rethrowSettingsError);
        const names = await lookupDisplayNames([template.createdBy]);
        return context.json({ template: detailViewOf(template, names) }, 201);
    });

    app.patch('/api/prompt-templates/:id', async (context) => {
        const auth = requireAuth(context);
        const templateId = parseTemplateId(context.req.param('id'));
        const { template } = await templateOf(templateId);
        requireTemplateOwner(auth, template);
        const patch = parsePromptTemplatePatchBody(await readJsonObject(context));
        const updated = await updatePromptTemplate(templateId, patch, {
            userId: auth.user.id,
            isOwner: auth.user.isOwner,
        }).catch(rethrowSettingsError);
        const names = await lookupDisplayNames([updated.createdBy]);
        return context.json({ template: detailViewOf(updated, names) });
    });

    app.delete('/api/prompt-templates/:id', async (context) => {
        const auth = requireAuth(context);
        const templateId = parseTemplateId(context.req.param('id'));
        const { template } = await templateOf(templateId);
        requireTemplateOwner(auth, template);
        await deletePromptTemplate(templateId, {
            userId: auth.user.id,
            isOwner: auth.user.isOwner,
        }).catch(rethrowSettingsError);
        return context.json({ ok: true });
    });

    app.get('/api/chats/:chatId/prompt-templates', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        await requireChatAccess(auth, chatId);

        const ownerUserId = getOwnerUserId();
        const settings = getChatSettings(chatId) ?? defaultChatSettings(chatId);
        const knownMemberIds = await loadKnownChatMemberIds(chatId);
        const tier = await resolvePanelAccessTier(auth);
        const viewerModel = effectiveReplyModel(tier, resolveChatModel(chatId));
        const isPrivateChat = chatId > 0;
        // A private template may load only in its creator's or the owner's private chat
        const privateChatUserId = isPrivateChat ? chatId : null;

        // isTemplateVisible itself hides private templates from group chats,
        // the owner included, so no outer owner shortcut may re-add them
        const visibilityContext = {
            viewerId: auth.user.id,
            isOwner: auth.user.isOwner,
            knownMemberIds,
            isPrivateChat,
        };
        const visible = listPromptTemplates().filter((template) =>
            isTemplateVisible(template, visibilityContext)
        );
        const names = await lookupDisplayNames(visible.map((template) => template.createdBy));
        const enabledIds = new Set(settings.promptTemplateIds ?? []);
        const templates: ChatPromptTemplateView[] = visible.map((template) => ({
            ...itemViewOf(template, names),
            // The expanded row shows the whole content, not the 120-code-point preview
            content: template.content,
            enabledInChat: enabledIds.has(template.id),
            autoMatchesViewerModel:
                isAutoCandidate(template, {
                    ownerId: ownerUserId ?? 0,
                    knownMemberIds,
                    privateChatUserId,
                }) && templateMatchesModel(template, viewerModel),
        }));
        return context.json({ templates });
    });
};
