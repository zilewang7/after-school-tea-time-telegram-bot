/**
 * In-memory copy of prompt_templates, the same shape as chat-settings-cache:
 * the table is small and prompt-templates-service is its only writer, so the
 * reply path reads templates synchronously and never touches the database.
 *
 * `modelPatterns` is stored as JSON and held parsed here, so no reader parses
 * JSON on the reply path. A row whose stored rules cannot be parsed is skipped
 * with a warning: guessing which models the author meant could auto-load the
 * template where they never intended it.
 */
import { PromptTemplateRecord } from '../db/promptTemplateDTO.js';
import { listChatSettings } from './chat-settings-cache.js';
import { parseStoredModelPatterns, type PromptTemplateVisibility } from './prompt-template-rules.js';

export interface PromptTemplate {
    readonly id: number;
    readonly name: string;
    readonly content: string;
    /** Parsed loading rules; empty = no rule, so the template only loads when a chat enables it by hand */
    readonly modelPatterns: readonly string[];
    readonly sortOrder: number;
    readonly visibility: PromptTemplateVisibility;
    readonly enabled: boolean;
    readonly createdBy: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

const templatesById = new Map<number, PromptTemplate>();
let cacheLoaded = false;
let inflightLoad: Promise<void> | null = null;

/** The stored visibility column: anything unrecognized reads as private, the most restrictive */
const storedVisibility = (value: string): PromptTemplateVisibility =>
    value === 'global' || value === 'group' ? value : 'private';

const toPromptTemplate = (record: PromptTemplateRecord): PromptTemplate | null => {
    const modelPatterns = parseStoredModelPatterns(record.modelPatterns);
    if (modelPatterns === null) return null;
    return {
        id: record.id,
        name: record.name,
        content: record.content,
        modelPatterns,
        sortOrder: record.sortOrder,
        visibility: storedVisibility(record.visibility),
        enabled: record.enabled,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
};

const readAllTemplates = async (): Promise<void> => {
    const records = await PromptTemplateRecord.findAll();
    templatesById.clear();
    for (const record of records) {
        const template = toPromptTemplate(record);
        if (template === null) continue;
        templatesById.set(template.id, template);
    }
    cacheLoaded = true;
};

/**
 * Load the table into memory. Call once after dbReady, before the bot takes
 * updates; concurrent calls share one load.
 */
export const loadPromptTemplatesCache = (): Promise<void> => {
    inflightLoad ??= readAllTemplates().finally(() => {
        inflightLoad = null;
    });
    return inflightLoad;
};

/** Writes before startup's load (a script, a test) still see every row */
export const ensurePromptTemplatesCacheLoaded = async (): Promise<void> => {
    if (!cacheLoaded) await loadPromptTemplatesCache();
};

export const isPromptTemplatesCacheLoaded = (): boolean => cacheLoaded;

/** Every template in composition order (sortOrder, then id) */
export const listPromptTemplates = (): readonly PromptTemplate[] =>
    [...templatesById.values()].sort(
        (left, right) => left.sortOrder - right.sortOrder || left.id - right.id
    );

export const getPromptTemplate = (id: number): PromptTemplate | undefined => templatesById.get(id);

/** Write-side: only prompt-templates-service calls this, after the row is committed */
export const storePromptTemplate = (template: PromptTemplate): void => {
    templatesById.set(template.id, template);
};

/** Write-side: only prompt-templates-service calls this, after the row is deleted */
export const removePromptTemplate = (id: number): void => {
    templatesById.delete(id);
};

/**
 * How many chats manually enabled the template; the delete confirmation shows
 * it. Reads the chat-settings cache, so a template of a chat whose settings
 * were never loaded reads as unused — both caches load at startup.
 */
export const countChatsUsingTemplate = (id: number): number =>
    listChatSettings().filter((settings) => settings.promptTemplateIds?.includes(id) === true).length;
