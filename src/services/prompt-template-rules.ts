/**
 * Pure rules of a prompt template and of composing a chat's addendum: how each
 * field is normalized and validated (design D8), how a loading rule matches a
 * model, and which templates a selection loads (design D3, §4.3). No I/O, so the
 * template service, the panel and the reply path share one implementation.
 */
import { countCodePoints } from '../shared/code-points.js';
import type { PromptTemplate } from './prompt-templates-cache.js';

/** A template name: 1-40 code points, unique per creator */
export const TEMPLATE_NAME_MAX_CODE_POINTS = 40;
/** Template content: 1-4000 code points */
export const TEMPLATE_CONTENT_MAX_CODE_POINTS = 4000;
/** Loading rules per template, and the length of one rule */
export const MODEL_PATTERN_MAX_COUNT = 20;
export const MODEL_PATTERN_MAX_LENGTH = 64;
/** Composition order range; smaller loads first */
export const TEMPLATE_SORT_ORDER_MAX = 100000;

/** Who may see and enable a template: everyone, the creator's groups, or the creator alone */
export type PromptTemplateVisibility = 'global' | 'group' | 'private';

export type TemplateFieldNormalization<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly message: string };

const INVALID_NAME: TemplateFieldNormalization<string> = {
    ok: false,
    message: `模板名必须是 1–${TEMPLATE_NAME_MAX_CODE_POINTS} 个字符，且不能包含换行`,
};
const INVALID_CONTENT: TemplateFieldNormalization<string> = {
    ok: false,
    message: `模板内容必须是 1–${TEMPLATE_CONTENT_MAX_CODE_POINTS} 个字符`,
};
const INVALID_PATTERNS: TemplateFieldNormalization<string[]> = {
    ok: false,
    message: `加载规则必须是每行一个模型匹配式、每个不超过 ${MODEL_PATTERN_MAX_LENGTH} 个字符；只支持 * 通配`,
};

/** Whether the text holds a C0 control (newline and tab optionally allowed), DEL or a noncharacter */
const hasForbiddenCharacter = (text: string, options: { newlineAndTab: boolean }): boolean => {
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const allowedControl = options.newlineAndTab && (codePoint === 0x09 || codePoint === 0x0a);
        if (codePoint < 0x20 && !allowedControl) return true;
        if (codePoint === 0x7f || codePoint === 0xfffe || codePoint === 0xffff) return true;
    }
    return false;
};

/** Trimmed 1-40 code points, no newline or other control character */
export const normalizeTemplateName = (raw: unknown): TemplateFieldNormalization<string> => {
    if (typeof raw !== 'string') return INVALID_NAME;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || countCodePoints(trimmed) > TEMPLATE_NAME_MAX_CODE_POINTS) return INVALID_NAME;
    if (hasForbiddenCharacter(trimmed, { newlineAndTab: false })) {
        return { ok: false, message: '模板名不能包含换行或控制字符' };
    }
    return { ok: true, value: trimmed };
};

/**
 * CRLF becomes LF, surrounding whitespace goes, blank is refused. Only newline
 * and tab are allowed as control characters; too long is an error, never a cut.
 */
export const normalizeTemplateContent = (raw: unknown): TemplateFieldNormalization<string> => {
    if (typeof raw !== 'string') return INVALID_CONTENT;
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    if (normalized.length === 0) return INVALID_CONTENT;
    if (countCodePoints(normalized) > TEMPLATE_CONTENT_MAX_CODE_POINTS) return INVALID_CONTENT;
    if (hasForbiddenCharacter(normalized, { newlineAndTab: true })) {
        return { ok: false, message: '模板内容包含不支持的字符' };
    }
    return { ok: true, value: normalized };
};

/**
 * Loading rules: each rule is trimmed and lowercased, blank entries are
 * dropped, duplicates go, 20 rules at most. Only `*` is a wildcard; every other
 * character matches literally (the matcher escapes them).
 */
export const normalizeModelPatterns = (raw: unknown): TemplateFieldNormalization<string[]> => {
    if (!Array.isArray(raw)) return INVALID_PATTERNS;
    const patterns = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string') return INVALID_PATTERNS;
        const pattern = entry.trim().toLowerCase();
        if (pattern.length === 0) continue;
        if (countCodePoints(pattern) > MODEL_PATTERN_MAX_LENGTH || /\s/.test(pattern)) return INVALID_PATTERNS;
        patterns.add(pattern);
    }
    if (patterns.size > MODEL_PATTERN_MAX_COUNT) return INVALID_PATTERNS;
    return { ok: true, value: [...patterns] };
};

/** The stored form: canonical JSON; `[]` means the author set no loading rule */
export const canonicalModelPatternsJson = (patterns: readonly string[]): string => JSON.stringify(patterns);

/**
 * A stored rule list read back. `null` means the stored value is unusable: the
 * cache skips such a row instead of guessing which models the author meant.
 */
export const parseStoredModelPatterns = (text: string): readonly string[] | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        console.warn('[prompt-templates] ignoring a stored model-pattern list that is not JSON');
        return null;
    }
    const normalized = normalizeModelPatterns(parsed);
    if (!normalized.ok) {
        console.warn(`[prompt-templates] ignoring an invalid stored model-pattern list: ${normalized.message}`);
        return null;
    }
    return normalized.value;
};

export const normalizeTemplateVisibility = (raw: unknown): TemplateFieldNormalization<PromptTemplateVisibility> => {
    if (raw === 'global' || raw === 'group' || raw === 'private') return { ok: true, value: raw };
    return { ok: false, message: '可见性只能是全局可见、同群群聊用户可见或完全隐藏' };
};

/** Integer 0-100000, absent means 0 */
export const normalizeSortOrder = (raw: unknown): TemplateFieldNormalization<number> => {
    if (raw === undefined || raw === null) return { ok: true, value: 0 };
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > TEMPLATE_SORT_ORDER_MAX) {
        return { ok: false, message: `排序必须是 0–${TEMPLATE_SORT_ORDER_MAX} 的整数` };
    }
    return { ok: true, value: raw };
};

/** The author's master switch; a new template starts enabled */
export const normalizeTemplateEnabled = (raw: unknown): TemplateFieldNormalization<boolean> => {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    return { ok: false, message: '模板级启用必须是布尔值' };
};

/** Escapes everything a regex would read as syntax, so a rule matches literally */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One loading rule against one model id: `*` is the only wildcard and the whole
 * id must match, case-insensitively (a rule is stored lowercased).
 */
export const modelMatchesPattern = (pattern: string, model: string): boolean => {
    const source = pattern
        .split('*')
        .map(escapeRegExp)
        .join('.*');
    return new RegExp(`^${source}$`, 'i').test(model);
};

/**
 * No rule means no automatic load (the template can still be enabled by hand);
 * an explicit `*` matches every model. Otherwise any rule may match.
 */
export const templateMatchesModel = (template: Pick<PromptTemplate, 'modelPatterns'>, model: string): boolean =>
    template.modelPatterns.some((pattern) => modelMatchesPattern(pattern, model));

/** What one reply loads, as the chat settings and the preview request carry it */
export interface AddendumSelection {
    readonly custom: string | null;
    readonly templateIds: readonly number[] | null;
    readonly auto: boolean;
}

/** Where the reply happens: a private chat names its user, a group names none */
export interface AddendumChatContext {
    /** The private chat's user id, or null when the reply is in a group */
    readonly privateChatUserId: number | null;
    readonly ownerId: number;
}

/** The member facts the automatic channel compares templates against */
export interface AutoCandidatesContext {
    readonly ownerId: number;
    readonly knownMemberIds: ReadonlySet<number>;
}

/** Everything the automatic channel needs; the private chat's user decides where a private template may load */
export interface AutoCandidateContext extends AutoCandidatesContext {
    readonly privateChatUserId: number | null;
}

export interface AppliedTemplate {
    readonly id: number;
    readonly name: string;
}

export interface ComposedAddendum {
    readonly text: string | null;
    readonly applied: readonly AppliedTemplate[];
    readonly customIncluded: boolean;
}

/**
 * Where a private template may load: only in the creator's own private chat or
 * in the owner's private chat. A group and anyone else's private chat never load
 * it, so one user's private prompt cannot reach another user's reply context.
 */
export const privateTemplateLoadable = (template: PromptTemplate, context: AddendumChatContext): boolean =>
    context.privateChatUserId !== null &&
    (template.createdBy === context.privateChatUserId || context.privateChatUserId === context.ownerId);

/**
 * Whether one template may be auto-loaded (design 2026-1119-1740 §变更1):
 * enabled, created by the owner or by a known member of this chat, and — for a
 * private template — in a chat that may load it (privateTemplateLoadable). The
 * loading rule is checked separately by templateMatchesModel; the manual list
 * never consults this rule.
 */
export const isAutoCandidate = (template: PromptTemplate, context: AutoCandidateContext): boolean => {
    if (!template.enabled) return false;
    if (template.createdBy !== context.ownerId && !context.knownMemberIds.has(template.createdBy)) return false;
    return (
        template.visibility !== 'private' ||
        privateTemplateLoadable(template, {
            privateChatUserId: context.privateChatUserId,
            ownerId: context.ownerId,
        })
    );
};

/**
 * The addendum one reply loads (design 2026-1119-1146 §4.3, 2026-1119-1740):
 * the manually enabled templates (whatever the model matches; a private one only
 * where privateTemplateLoadable allows it), then the auto-loaded ones
 * (isAutoCandidate and a loading rule that matches the model), deduplicated by
 * id, ordered by (sortOrder, id), joined by a blank line, and the chat's own
 * text last.
 */
export const composeChatAddendum = (
    selection: AddendumSelection,
    templates: readonly PromptTemplate[],
    model: string,
    autoContext: AutoCandidatesContext | null,
    chat: AddendumChatContext
): ComposedAddendum => {
    const byId = new Map(templates.map((template) => [template.id, template] as const));
    const applied: PromptTemplate[] = [];
    const appliedIds = new Set<number>();
    const apply = (template: PromptTemplate): void => {
        if (appliedIds.has(template.id)) return;
        appliedIds.add(template.id);
        applied.push(template);
    };

    for (const id of selection.templateIds ?? []) {
        const template = byId.get(id);
        if (template === undefined || !template.enabled) continue;
        // A private template loads only in the creator's or the owner's private chat
        if (template.visibility === 'private' && !privateTemplateLoadable(template, chat)) continue;
        apply(template);
    }
    if (selection.auto && autoContext !== null) {
        const candidateContext: AutoCandidateContext = {
            ...autoContext,
            privateChatUserId: chat.privateChatUserId,
        };
        for (const template of templates) {
            if (!isAutoCandidate(template, candidateContext)) continue;
            if (!templateMatchesModel(template, model)) continue;
            apply(template);
        }
    }

    applied.sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);

    const custom = selection.custom;
    const customIncluded = custom !== null && custom.trim().length > 0;
    const parts = applied.map((template) => template.content);
    if (customIncluded && custom !== null) parts.push(custom);
    return {
        text: parts.length === 0 ? null : parts.join('\n\n'),
        applied: applied.map((template) => ({ id: template.id, name: template.name })),
        customIncluded,
    };
};
