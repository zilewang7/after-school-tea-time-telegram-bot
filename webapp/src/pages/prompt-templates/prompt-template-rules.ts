import { countCodePoints } from '../../addendum';
import type {
    PromptTemplateCreateRequest,
    PromptTemplateDetail,
    PromptTemplatePatch,
    PromptTemplateVisibility,
} from '../../api';
import {
    PROMPT_TEMPLATE_CONTENT_MAX,
    PROMPT_TEMPLATE_NAME_MAX,
    PROMPT_TEMPLATE_PATTERN_MAX,
    PROMPT_TEMPLATE_PATTERNS_MAX,
    PROMPT_TEMPLATE_SORT_ORDER_MAX,
} from '../../prompt-templates';

/** The template form's values, as typed */
export interface PromptTemplateDraft {
    name: string;
    content: string;
    // One model pattern per line
    patternsText: string;
    visibility: PromptTemplateVisibility;
    enabled: boolean;
    // As typed; empty = 0
    sortOrderText: string;
}

/** The normalized field values plus the first error of each field; valid = no error */
export interface PromptTemplateDraftValidation {
    name: string;
    content: string;
    modelPatterns: string[];
    sortOrder: number;
    nameError: string | null;
    contentError: string | null;
    patternsError: string | null;
    sortOrderError: string | null;
    valid: boolean;
}

const PATTERNS_ERROR_MESSAGE = `加载规则必须是每行一个模型匹配式、每个不超过 ${PROMPT_TEMPLATE_PATTERN_MAX} 个字符；只支持 * 通配`;
const SORT_ORDER_ERROR_MESSAGE = `排序必须是 0–${PROMPT_TEMPLATE_SORT_ORDER_MAX} 的整数`;

// C0 controls the server refuses; tab and newline stay allowed
const isUnsupportedContentCodePoint = (codePoint: number): boolean =>
    codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    codePoint === 0xfffe ||
    codePoint === 0xffff;

const hasUnsupportedContentCharacters = (text: string): boolean => {
    for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && isUnsupportedContentCodePoint(codePoint)) return true;
    }
    return false;
};

const PATTERN_WHITESPACE = /\s/;

/** Lines to patterns: trimmed, lower-cased, blank lines dropped, order kept, duplicates dropped */
export const modelPatternsOf = (patternsText: string): string[] => {
    const patterns = patternsText
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== '');
    return Array.from(new Set(patterns));
};

const nameErrorOf = (name: string): string | null => {
    const length = countCodePoints(name);
    return length < 1 || length > PROMPT_TEMPLATE_NAME_MAX
        ? `模板名必须是 1–${PROMPT_TEMPLATE_NAME_MAX} 个字符`
        : null;
};

const contentErrorOf = (content: string): string | null => {
    const length = countCodePoints(content);
    if (length < 1 || length > PROMPT_TEMPLATE_CONTENT_MAX) {
        return `模板内容必须是 1–${PROMPT_TEMPLATE_CONTENT_MAX} 个字符`;
    }
    return hasUnsupportedContentCharacters(content) ? '模板内容包含不支持的字符' : null;
};

const patternsErrorOf = (patterns: readonly string[]): string | null => {
    if (patterns.length > PROMPT_TEMPLATE_PATTERNS_MAX) return PATTERNS_ERROR_MESSAGE;
    const invalid = patterns.some(
        (pattern) => pattern.length > PROMPT_TEMPLATE_PATTERN_MAX || PATTERN_WHITESPACE.test(pattern)
    );
    return invalid ? PATTERNS_ERROR_MESSAGE : null;
};

const sortOrderNumberOf = (sortOrderText: string): number => {
    const trimmed = sortOrderText.trim();
    return trimmed === '' ? 0 : Number(trimmed);
};

const sortOrderErrorOf = (sortOrder: number): string | null =>
    Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder <= PROMPT_TEMPLATE_SORT_ORDER_MAX
        ? null
        : SORT_ORDER_ERROR_MESSAGE;

/** The normalized values the server would store, plus every field error the page shows */
export const validatePromptTemplateDraft = (draft: PromptTemplateDraft): PromptTemplateDraftValidation => {
    const name = draft.name.trim();
    // The server normalizes CRLF and trims the content
    const content = draft.content.replaceAll('\r\n', '\n').trim();
    const modelPatterns = modelPatternsOf(draft.patternsText);
    const sortOrder = sortOrderNumberOf(draft.sortOrderText);
    const nameError = nameErrorOf(name);
    const contentError = contentErrorOf(content);
    const patternsError = patternsErrorOf(modelPatterns);
    const sortOrderError = sortOrderErrorOf(sortOrder);
    return {
        name,
        content,
        modelPatterns,
        sortOrder,
        nameError,
        contentError,
        patternsError,
        sortOrderError,
        valid: nameError === null && contentError === null && patternsError === null && sortOrderError === null,
    };
};

/** The initial form values: a new template, or the one being edited */
export const promptTemplateDraftOf = (template: PromptTemplateDetail | null): PromptTemplateDraft =>
    template === null
        ? { name: '', content: '', patternsText: '', visibility: 'global', enabled: true, sortOrderText: '0' }
        : {
              name: template.name,
              content: template.content,
              patternsText: template.modelPatterns.join('\n'),
              visibility: template.visibility,
              enabled: template.enabled,
              sortOrderText: String(template.sortOrder),
          };

/** Whether the form has anything unsaved; a new template always has (it does not exist yet) */
export const promptTemplateDraftChangedOf = (
    template: PromptTemplateDetail | null,
    draft: PromptTemplateDraft
): boolean => {
    if (template === null) return true;
    const validation = validatePromptTemplateDraft(draft);
    return (
        validation.name !== template.name ||
        validation.content !== template.content ||
        JSON.stringify(validation.modelPatterns) !== JSON.stringify(template.modelPatterns) ||
        draft.visibility !== template.visibility ||
        draft.enabled !== template.enabled ||
        validation.sortOrder !== template.sortOrder
    );
};

/** The POST body; call it with a valid draft only */
export const promptTemplateCreateRequestOf = (
    draft: PromptTemplateDraft,
    validation: PromptTemplateDraftValidation
): PromptTemplateCreateRequest => ({
    name: validation.name,
    content: validation.content,
    modelPatterns: validation.modelPatterns,
    visibility: draft.visibility,
    sortOrder: validation.sortOrder,
    enabled: draft.enabled,
});

/** Only the fields that differ from the saved template */
export const promptTemplatePatchOf = (
    template: PromptTemplateDetail,
    draft: PromptTemplateDraft,
    validation: PromptTemplateDraftValidation
): PromptTemplatePatch => {
    const patch: PromptTemplatePatch = {};
    if (validation.name !== template.name) patch.name = validation.name;
    if (validation.content !== template.content) patch.content = validation.content;
    if (JSON.stringify(validation.modelPatterns) !== JSON.stringify(template.modelPatterns)) {
        patch.modelPatterns = validation.modelPatterns;
    }
    if (draft.visibility !== template.visibility) patch.visibility = draft.visibility;
    if (draft.enabled !== template.enabled) patch.enabled = draft.enabled;
    if (validation.sortOrder !== template.sortOrder) patch.sortOrder = validation.sortOrder;
    return patch;
};
