// Prompt template rules and labels shared by the 模板 page and the chat settings field
// (prompt-template design D8/D10). The server enforces the same limits.

import type { ChatPromptTemplateSummary, PromptTemplateSummary, PromptTemplateVisibility } from './api';

export const PROMPT_TEMPLATE_NAME_MAX = 40;
export const PROMPT_TEMPLATE_CONTENT_MAX = 4000;
// One model id glob per line
export const PROMPT_TEMPLATE_PATTERN_MAX = 64;
export const PROMPT_TEMPLATE_PATTERNS_MAX = 20;
export const PROMPT_TEMPLATE_SORT_ORDER_MAX = 100000;
// Templates a chat may enable manually
export const PROMPT_TEMPLATE_SELECTION_MAX = 10;

const VISIBILITY_LABELS: Record<PromptTemplateVisibility, string> = {
    global: '全局可见',
    group: '同群可见',
    private: '完全隐藏',
};

/** The list's short label; the page's chips spell the group case out */
export const promptTemplateVisibilityLabel = (visibility: PromptTemplateVisibility): string =>
    VISIBILITY_LABELS[visibility];

/** The rule as one line; a template without one is never auto-loaded (manual enable still works) */
export const promptTemplatePatternsLabel = (patterns: readonly string[]): string =>
    patterns.length === 0 ? '未设置规则（不自动加载）' : patterns.join('、');

/** The creator's name when somebody else made the template, null for the viewer's own */
export const promptTemplateCreatorNameOf = (
    template: Pick<PromptTemplateSummary, 'createdBy' | 'createdByName'>,
    viewerId: number
): string | null => (template.createdBy === viewerId ? null : template.createdByName);

/** A delete confirmation that names the chats which will stop loading the template */
export const promptTemplateDeleteMessage = (template: Pick<PromptTemplateSummary, 'name' | 'chatCount'>): string =>
    template.chatCount === 0
        ? `删除模板「${template.name}」？删除后不可恢复。`
        : `有 ${template.chatCount} 个会话启用了「${template.name}」，删除后这些会话不再加载。确定删除？`;

/** 「3 个会话启用」 */
export const promptTemplateChatCountLabel = (chatCount: number): string => `${chatCount} 个会话启用`;

/**
 * Sum of the manually enabled templates' contents, in code points. The session list
 * carries only `contentLength`, so this is the same approximation the server uses
 * for the 8000 limit line (it does the final check against the full contents).
 * A template that its author disabled does not load, so it adds nothing.
 */
export const enabledTemplateContentLengthOf = (
    templates: readonly Pick<ChatPromptTemplateSummary, 'id' | 'contentLength' | 'enabled'>[],
    selectedIds: readonly number[]
): number => {
    const selected = new Set(selectedIds);
    return templates.reduce(
        (total, template) =>
            template.enabled && selected.has(template.id) ? total + template.contentLength : total,
        0
    );
};
