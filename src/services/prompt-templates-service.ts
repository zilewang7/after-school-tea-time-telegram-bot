/**
 * The only write path for prompt templates (design D1/D7), and the composer the
 * reply path calls.
 *
 * Every write runs in one serialized queue: the name-uniqueness and
 * per-creator-count checks inside the queue therefore never race, the row is
 * written in a transaction, and only the committed value enters the cache. A
 * failed write leaves both the table and the cache as they were.
 *
 * `resolveReplyAddendum` is the reply path's entry: it reads the cache
 * synchronously and only touches the database for the member lookup the
 * automatic candidates need, and only while the chat's auto switch is on.
 */
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { PromptTemplateRecord } from '../db/promptTemplateDTO.js';
import { isJsonObject } from '../shared/json-object.js';
import { getOwnerUserId } from '../config/owner.js';
import { countCodePoints } from '../shared/code-points.js';
import { CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS } from './chat-settings-rules.js';
import {
    ensurePromptTemplatesCacheLoaded,
    getPromptTemplate,
    listPromptTemplates,
    removePromptTemplate,
    storePromptTemplate,
    type PromptTemplate,
} from './prompt-templates-cache.js';
import {
    canonicalModelPatternsJson,
    composeChatAddendum,
    normalizeModelPatterns,
    normalizeSortOrder,
    normalizeTemplateContent,
    normalizeTemplateEnabled,
    normalizeTemplateName,
    normalizeTemplateVisibility,
    type AddendumSelection,
    type AutoCandidatesContext,
    type ComposedAddendum,
    type PromptTemplateVisibility,
    type TemplateFieldNormalization,
} from './prompt-template-rules.js';
import { loadKnownChatMemberIds } from './prompt-template-visibility.js';
import { ChatSettingsError, type SettingsActor } from './settings-errors.js';
import { runSerialized } from './settings-write-queue.js';

/** The template write queue: separate from every chat's settings queue */
const TEMPLATE_WRITE_SCOPE = 'prompt-templates';

/** How many templates one user may create (design D8) */
export const MAX_TEMPLATES_PER_CREATOR = 100;

/** One template's fields, as the panel form sends them */
export interface PromptTemplateInput {
    name: string;
    content: string;
    modelPatterns: readonly string[];
    sortOrder: number;
    visibility: PromptTemplateVisibility;
    enabled: boolean;
}

/** The field names a create or a patch may carry */
const INPUT_KEYS = ['name', 'content', 'modelPatterns', 'sortOrder', 'visibility', 'enabled'] as const;

/** Write-side: the cache object built from the values that were just written */
const templateOf = (
    id: number,
    input: PromptTemplateInput,
    createdBy: number,
    createdAt: Date,
    updatedAt: Date
): PromptTemplate => ({
    id,
    name: input.name,
    content: input.content,
    modelPatterns: input.modelPatterns,
    sortOrder: input.sortOrder,
    visibility: input.visibility,
    enabled: input.enabled,
    createdBy,
    createdAt,
    updatedAt,
});

/** A rejected field: every normalization reports the same way */
const invalidField = <T>(normalized: TemplateFieldNormalization<T>): T => {
    if (!normalized.ok) throw new ChatSettingsError('invalid', normalized.message);
    return normalized.value;
};

/** The panel's field set; absent optional fields take the design's defaults */
const normalizeCreateInput = (input: unknown): PromptTemplateInput => {
    if (!isJsonObject(input)) throw new ChatSettingsError('invalid', '模板数据格式不正确');
    return {
        name: invalidField(normalizeTemplateName(input.name)),
        content: invalidField(normalizeTemplateContent(input.content)),
        modelPatterns:
            input.modelPatterns === undefined
                ? []
                : invalidField(normalizeModelPatterns(input.modelPatterns)),
        sortOrder: invalidField(normalizeSortOrder(input.sortOrder)),
        visibility:
            input.visibility === undefined
                ? 'private'
                : invalidField(normalizeTemplateVisibility(input.visibility)),
        enabled: input.enabled === undefined ? true : invalidField(normalizeTemplateEnabled(input.enabled)),
    };
};

/** The current fields with every present field of the patch normalized on top */
const normalizeUpdateInput = (current: PromptTemplate, patch: unknown): PromptTemplateInput => {
    if (!isJsonObject(patch)) throw new ChatSettingsError('invalid', '模板数据格式不正确');
    if (!INPUT_KEYS.some((key) => patch[key] !== undefined)) {
        throw new ChatSettingsError('invalid', '至少需要修改一个模板字段');
    }
    return {
        name: patch.name === undefined ? current.name : invalidField(normalizeTemplateName(patch.name)),
        content: patch.content === undefined
            ? current.content
            : invalidField(normalizeTemplateContent(patch.content)),
        modelPatterns: patch.modelPatterns === undefined
            ? current.modelPatterns
            : invalidField(normalizeModelPatterns(patch.modelPatterns)),
        sortOrder: patch.sortOrder === undefined
            ? current.sortOrder
            : invalidField(normalizeSortOrder(patch.sortOrder)),
        visibility: patch.visibility === undefined
            ? current.visibility
            : invalidField(normalizeTemplateVisibility(patch.visibility)),
        enabled: patch.enabled === undefined
            ? current.enabled
            : invalidField(normalizeTemplateEnabled(patch.enabled)),
    };
};

/** A name is unique per creator, not globally */
const assertNameAvailable = (name: string, createdBy: number, exceptId: number | null): void => {
    const taken = listPromptTemplates().some(
        (template) =>
            template.id !== exceptId && template.createdBy === createdBy && template.name === name
    );
    if (taken) throw new ChatSettingsError('invalid', '已存在同名模板');
};

/** The editable input of one template, once the caller's right to touch it is checked */
const editableTemplateOf = (id: number, actor: SettingsActor): PromptTemplate => {
    const template = getPromptTemplate(id);
    if (template === undefined) throw new ChatSettingsError('not_found', '模板不存在');
    if (!actor.isOwner && template.createdBy !== actor.userId) {
        throw new ChatSettingsError('forbidden', '只有创建者或机主可以修改或删除模板');
    }
    return template;
};

/** Any logged-in panel user may create a template; it starts private and enabled */
export const createPromptTemplate = (input: unknown, actor: SettingsActor): Promise<PromptTemplate> =>
    runSerialized(TEMPLATE_WRITE_SCOPE, async () => {
        await ensurePromptTemplatesCacheLoaded();
        const fields = normalizeCreateInput(input);
        const createdBy = actor.userId;
        const ownTemplates = listPromptTemplates().filter((template) => template.createdBy === createdBy);
        if (ownTemplates.length >= MAX_TEMPLATES_PER_CREATOR) {
            throw new ChatSettingsError('invalid', `模板数量已达上限（${MAX_TEMPLATES_PER_CREATOR} 个）`);
        }
        assertNameAvailable(fields.name, createdBy, null);
        const record = await withBusyRetry(
            () =>
                sequelize.transaction((transaction) =>
                    PromptTemplateRecord.create(
                        {
                            name: fields.name,
                            content: fields.content,
                            modelPatterns: canonicalModelPatternsJson(fields.modelPatterns),
                            sortOrder: fields.sortOrder,
                            visibility: fields.visibility,
                            enabled: fields.enabled,
                            createdBy,
                        },
                        { transaction }
                    )
                ),
            'prompt template create'
        );
        const template = templateOf(record.id, fields, createdBy, record.createdAt, record.updatedAt);
        storePromptTemplate(template);
        return template;
    });

/** Only the creator or the owner: rename, rewrite, retune the rule or enable/disable */
export const updatePromptTemplate = (
    id: number,
    patch: unknown,
    actor: SettingsActor
): Promise<PromptTemplate> =>
    runSerialized(TEMPLATE_WRITE_SCOPE, async () => {
        await ensurePromptTemplatesCacheLoaded();
        const current = editableTemplateOf(id, actor);
        const fields = normalizeUpdateInput(current, patch);
        if (fields.name !== current.name) assertNameAvailable(fields.name, current.createdBy, id);
        const record = await withBusyRetry(
            () =>
                sequelize.transaction(async (transaction) => {
                    const row = await PromptTemplateRecord.findByPk(id, { transaction });
                    if (row === null) return null;
                    row.name = fields.name;
                    row.content = fields.content;
                    row.modelPatterns = canonicalModelPatternsJson(fields.modelPatterns);
                    row.sortOrder = fields.sortOrder;
                    row.visibility = fields.visibility;
                    row.enabled = fields.enabled;
                    await row.save({ transaction });
                    return row;
                }),
            `prompt template update ${id}`
        );
        // A concurrent delete through another process: the cache drops it with the next load
        if (record === null) throw new ChatSettingsError('not_found', '模板不存在');
        const template = templateOf(id, fields, current.createdBy, current.createdAt, record.updatedAt);
        storePromptTemplate(template);
        return template;
    });

/** Old ids in chats' enable lists stay there and are skipped when composing (design D12) */
export const deletePromptTemplate = (id: number, actor: SettingsActor): Promise<void> =>
    runSerialized(TEMPLATE_WRITE_SCOPE, async () => {
        await ensurePromptTemplatesCacheLoaded();
        editableTemplateOf(id, actor);
        await withBusyRetry(
            () =>
                sequelize.transaction((transaction) =>
                    PromptTemplateRecord.destroy({ where: { id }, transaction })
                ),
            `prompt template delete ${id}`
        );
        removePromptTemplate(id);
    });

/**
 * The addendum one reply loads (design D3/D4): the chat's manually enabled
 * templates always, plus the auto candidates while the chat's switch is on.
 * Asynchronous only because the auto candidates need the chat's known members;
 * with the switch off it reads the cache alone.
 */
export const resolveReplyAddendum = async (
    chatId: number,
    selection: AddendumSelection,
    model: string
): Promise<ComposedAddendum> => {
    await ensurePromptTemplatesCacheLoaded();
    let autoContext: AutoCandidatesContext | null = null;
    if (selection.auto) {
        // Without a configured owner no id can be the owner's; 0 is not a user id
        autoContext = {
            ownerId: getOwnerUserId() ?? 0,
            knownMemberIds: await loadKnownChatMemberIds(chatId),
        };
    }
    const composed = composeChatAddendum(selection, listPromptTemplates(), model, autoContext);
    if (composed.text !== null) {
        const composedCodePoints = countCodePoints(composed.text);
        if (composedCodePoints > CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS) {
            console.warn(
                `[prompt-templates] chat ${chatId} composed ${composedCodePoints} code points; ` +
                    `the save-time limit is ${CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS}`
            );
        }
    }
    return composed;
};
