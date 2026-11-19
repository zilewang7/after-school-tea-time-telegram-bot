/**
 * Bodies of the prompt-template routes: type checks and per-field
 * normalization happen here (400 with a message meant for people), while
 * uniqueness, ownership and count limits belong to the service. A create needs
 * a name and content; everything else has a default. A patch carries at least
 * one field and may carry any subset.
 */
import {
    normalizeModelPatterns,
    normalizeSortOrder,
    normalizeTemplateContent,
    normalizeTemplateName,
    normalizeTemplateVisibility,
    type PromptTemplateVisibility,
} from '../../services/prompt-template-rules.js';
import type { PromptTemplateInput } from '../../services/prompt-templates-service.js';
import type { JsonRecord } from '../json.js';
import { checkBodyKeys, invalid } from '../request.js';

const TEMPLATE_KEYS = ['name', 'content', 'modelPatterns', 'sortOrder', 'visibility', 'enabled'] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>(TEMPLATE_KEYS);
const REQUIRED_LOCALLY: readonly string[] = ['name', 'content'];

const nameValue = (value: unknown): string => {
    const normalized = normalizeTemplateName(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

const contentValue = (value: unknown): string => {
    const normalized = normalizeTemplateContent(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

const patternsValue = (value: unknown): readonly string[] => {
    const normalized = normalizeModelPatterns(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

const sortOrderValue = (value: unknown): number => {
    const normalized = normalizeSortOrder(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

const visibilityValue = (value: unknown): PromptTemplateVisibility => {
    const normalized = normalizeTemplateVisibility(value);
    if (!normalized.ok) throw invalid(normalized.message);
    return normalized.value;
};

const enabledValue = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw invalid('enabled 必须是布尔值');
    return value;
};

/** The full create body; absent optional fields take the template defaults */
export const parsePromptTemplateCreateBody = (body: JsonRecord): PromptTemplateInput => {
    checkBodyKeys(body, ALLOWED_KEYS, REQUIRED_LOCALLY);
    return {
        name: nameValue(body.name),
        content: contentValue(body.content),
        modelPatterns: body.modelPatterns === undefined ? [] : patternsValue(body.modelPatterns),
        sortOrder: body.sortOrder === undefined ? 0 : sortOrderValue(body.sortOrder),
        visibility: body.visibility === undefined ? 'global' : visibilityValue(body.visibility),
        enabled: body.enabled === undefined ? true : enabledValue(body.enabled),
    };
};

/** Only the fields present; at least one is required */
export const parsePromptTemplatePatchBody = (body: JsonRecord): Partial<PromptTemplateInput> => {
    checkBodyKeys(body, ALLOWED_KEYS, TEMPLATE_KEYS);
    const patch: Partial<PromptTemplateInput> = {};
    if (Object.hasOwn(body, 'name')) patch.name = nameValue(body.name);
    if (Object.hasOwn(body, 'content')) patch.content = contentValue(body.content);
    if (Object.hasOwn(body, 'modelPatterns')) patch.modelPatterns = patternsValue(body.modelPatterns);
    if (Object.hasOwn(body, 'sortOrder')) patch.sortOrder = sortOrderValue(body.sortOrder);
    if (Object.hasOwn(body, 'visibility')) patch.visibility = visibilityValue(body.visibility);
    if (Object.hasOwn(body, 'enabled')) patch.enabled = enabledValue(body.enabled);
    return patch;
};
