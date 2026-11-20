/**
 * Argument parsing of the workspace tools. Pure, so the offline suite can pin
 * the wording and the rules without a database.
 */
import { normalizeWorkspacePath, normalizeWorkspacePrefix } from '../../services/workspace-service.js';

export type Parsed<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string };

const textArg = (raw: unknown, field: string): Parsed<string> =>
    typeof raw === 'string'
        ? { ok: true, value: raw }
        : { ok: false, error: `参数有误：${field} 要传字符串。` };

const boolArg = (raw: unknown, field: string): Parsed<boolean> =>
    raw === undefined || raw === null
        ? { ok: true, value: false }
        : typeof raw === 'boolean'
          ? { ok: true, value: raw }
          : { ok: false, error: `参数有误：${field} 要传 true / false。` };

const intArg = (raw: unknown, field: string, fallback: number): Parsed<number> =>
    raw === undefined || raw === null
        ? { ok: true, value: fallback }
        : typeof raw === 'number' && Number.isInteger(raw)
          ? { ok: true, value: raw }
          : { ok: false, error: `参数有误：${field} 要传整数。` };

const pathArg = (raw: unknown, field = 'path'): Parsed<string> => {
    const text = textArg(raw, field);
    if (!text.ok) return text;
    const normalized = normalizeWorkspacePath(text.value);
    return normalized.ok ? { ok: true, value: normalized.path } : { ok: false, error: normalized.error };
};

/**
 * Limits of one multi-file call (design 2026-1120-1638 §6). read shares one
 * call's character budget, so its cap is a file count only.
 */
export const WRITE_BATCH_MAX = 10;
export const WRITE_BATCH_CONTENT_CHARS_MAX = 32_000;
export const READ_BATCH_MAX = 10;
export const EDIT_BATCH_MAX = 5;
export const PREVIEW_BATCH_MAX = 3;

/** Every problem of one call at once, in the media tools' wording */
const argumentError = (problems: readonly string[]): { readonly ok: false; readonly error: string } => ({
    ok: false,
    error: `参数有误：\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A single-form field with real text; blank strings are fillers next to a batch field */
const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** How a batch names an item whose path the model did not write: its position */
const itemLabel = (raw: unknown, index: number): string =>
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : `第 ${index + 1} 项`;

/** A batch item that could not even be parsed; the tool reports it beside the executed ones */
export interface BatchItemFailure {
    readonly ok: false;
    /** The path the model wrote, or `第 N 项` */
    readonly label: string;
    readonly error: string;
}

/** The shared offset/limit of a read batch; the single-file rules, without the reject wording */
const readPagingOf = (raw: Readonly<Record<string, unknown>>): {
    readonly offset: number;
    readonly limit: number;
    readonly problems: readonly string[];
} => {
    const problems: string[] = [];
    let offset = 1;
    let limit = READ_LIMIT_DEFAULT;
    const rawOffset = raw.offset;
    if (rawOffset !== undefined && rawOffset !== null) {
        if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset)) problems.push('offset 要传整数');
        else if (rawOffset < 1) problems.push('offset 从 1 开始');
        else offset = rawOffset;
    }
    const rawLimit = raw.limit;
    if (rawLimit !== undefined && rawLimit !== null) {
        if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit)) problems.push('limit 要传整数');
        else if (rawLimit < 1) problems.push('limit 要大于 0');
        else limit = Math.min(rawLimit, READ_LIMIT_MAX);
    }
    return { offset, limit, problems };
};

/** A batch of workspace paths (read, preview): shape problems fail the call, a bad path fails its item */
export type WorkspacePathBatchItem =
    | { readonly ok: true; readonly path: string }
    | BatchItemFailure;

const parsePathBatchItems = (
    values: readonly unknown[],
    maxItems: number,
    field: string
): Parsed<readonly WorkspacePathBatchItem[]> => {
    const problems: string[] = [];
    if (values.length === 0) problems.push(`${field} 是空的：至少给 1 个路径`);
    if (values.length > maxItems) problems.push(`${field} 最多 ${maxItems} 项（现在 ${values.length} 项）`);
    for (const [index, value] of values.entries()) {
        if (typeof value !== 'string') problems.push(`${field} 第 ${index + 1} 项要传字符串`);
        else if (value.trim() === '') problems.push(`${field} 第 ${index + 1} 项是空的`);
    }
    if (problems.length > 0) return argumentError(problems);
    const items: WorkspacePathBatchItem[] = [];
    for (const [index, value] of values.entries()) {
        if (typeof value !== 'string') continue;
        const normalized = normalizeWorkspacePath(value);
        items.push(
            normalized.ok
                ? { ok: true, path: normalized.path }
                : { ok: false, label: itemLabel(value, index), error: normalized.error }
        );
    }
    return { ok: true, value: items };
};

export interface WorkspaceWriteArgs {
    readonly path: string;
    readonly content: string;
    readonly append: boolean;
    readonly overwrite: boolean;
}

export const parseWorkspaceWriteArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceWriteArgs> => {
    const path = pathArg(raw.path);
    if (!path.ok) return path;
    const content = textArg(raw.content, 'content');
    if (!content.ok) return content;
    const append = boolArg(raw.append, 'append');
    if (!append.ok) return append;
    const overwrite = boolArg(raw.overwrite, 'overwrite');
    if (!overwrite.ok) return overwrite;
    if (append.value && overwrite.value) {
        return { ok: false, error: 'append 和 overwrite 不能同时为 true；追加或整体替换只能选一个。' };
    }
    return {
        ok: true,
        value: { path: path.value, content: content.value, append: append.value, overwrite: overwrite.value },
    };
};

export type WorkspaceWriteBatchItem =
    | {
          readonly ok: true;
          /** The item's own `workspace` selector, resolved by the tool */
          readonly workspace: unknown;
          readonly args: WorkspaceWriteArgs;
      }
    | BatchItemFailure;

const parseWriteBatchItem = (raw: Readonly<Record<string, unknown>>, index: number): WorkspaceWriteBatchItem => {
    const label = itemLabel(raw.path, index);
    const path = pathArg(raw.path);
    if (!path.ok) return { ok: false, label, error: path.error };
    const content = textArg(raw.content, 'content');
    if (!content.ok) return { ok: false, label, error: content.error };
    const append = boolArg(raw.append, 'append');
    if (!append.ok) return { ok: false, label, error: append.error };
    const overwrite = boolArg(raw.overwrite, 'overwrite');
    if (!overwrite.ok) return { ok: false, label, error: overwrite.error };
    if (append.value && overwrite.value) {
        return { ok: false, label, error: 'append 和 overwrite 不能同时为 true；追加或整体替换只能选一个。' };
    }
    return {
        ok: true,
        workspace: raw.workspace,
        args: { path: path.value, content: content.value, append: append.value, overwrite: overwrite.value },
    };
};

/**
 * The `files` form of workspace_write: one self-contained write per item.
 *
 * Shape problems (an empty array, too many items, the whole text over the
 * per-call budget, a mix with the single-file fields) fail the call before any
 * write; a bad path or content only fails that item.
 */
export const parseWorkspaceWriteBatchArgs = (
    raw: Readonly<Record<string, unknown>>
): Parsed<readonly WorkspaceWriteBatchItem[]> => {
    const files = raw.files;
    if (!Array.isArray(files)) {
        return argumentError(['files 要传数组，每项是 { path, content, append?, overwrite?, workspace? }']);
    }
    const problems: string[] = [];
    if (hasText(raw.path)) problems.push('files 和 path 只能给一个');
    if (hasText(raw.content)) problems.push('files 和 content 只能给一个');
    if (raw.append === true || raw.overwrite === true) {
        problems.push('files 形态下 append/overwrite 写在每一项里（顶层的只用于单文件形态）');
    }
    if (typeof raw.workspace === 'string' && raw.workspace.trim() !== '') {
        problems.push('files 形态下 workspace 写在每一项里（顶层的只用于单文件形态）');
    }
    if (files.length === 0) problems.push('files 是空的：至少写 1 个文件');
    if (files.length > WRITE_BATCH_MAX) problems.push(`files 最多 ${WRITE_BATCH_MAX} 项（现在 ${files.length} 项）`);
    const totalChars = files.reduce((total, item) => {
        const content = isRecord(item) ? item.content : undefined;
        return typeof content === 'string' ? total + Array.from(content).length : total;
    }, 0);
    if (totalChars > WRITE_BATCH_CONTENT_CHARS_MAX) {
        problems.push(
            `一次写入的内容合计最多 ${WRITE_BATCH_CONTENT_CHARS_MAX} 字符（现在 ${totalChars} 字符），请分两次调用`
        );
    }
    const nonObject = files.findIndex((item) => !isRecord(item));
    if (nonObject >= 0) problems.push(`第 ${nonObject + 1} 项不是对象，每项要写成 { path, content }`);
    if (problems.length > 0) return argumentError(problems);
    const items: WorkspaceWriteBatchItem[] = [];
    for (const [index, item] of files.entries()) {
        if (!isRecord(item)) continue;
        items.push(parseWriteBatchItem(item, index));
    }
    return { ok: true, value: items };
};

export interface WorkspaceReadArgs {
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
}

/** Lines one read may return; the character budget below still applies */
export const READ_LIMIT_DEFAULT = 200;
export const READ_LIMIT_MAX = 800;

export const parseWorkspaceReadArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceReadArgs> => {
    const path = pathArg(raw.path);
    if (!path.ok) return path;
    const offset = intArg(raw.offset, 'offset', 1);
    if (!offset.ok) return offset;
    if (offset.value < 1) return { ok: false, error: 'offset 从 1 开始。' };
    const limit = intArg(raw.limit, 'limit', READ_LIMIT_DEFAULT);
    if (!limit.ok) return limit;
    if (limit.value < 1) return { ok: false, error: 'limit 要大于 0。' };
    return {
        ok: true,
        value: {
            path: path.value,
            offset: offset.value,
            limit: Math.min(limit.value, READ_LIMIT_MAX),
        },
    };
};

export interface WorkspaceReadBatchArgs {
    readonly items: readonly WorkspacePathBatchItem[];
    /** Shared by every file of the batch */
    readonly offset: number;
    readonly limit: number;
    /** The workspace selector shared by the whole batch */
    readonly workspace: unknown;
}

export const parseWorkspaceReadBatchArgs = (
    raw: Readonly<Record<string, unknown>>
): Parsed<WorkspaceReadBatchArgs> => {
    const paths = raw.paths;
    if (!Array.isArray(paths)) {
        return argumentError(['paths 要传字符串数组，如 ["notes/plan.md","src/main.ts"]']);
    }
    const problems: string[] = [];
    if (hasText(raw.path)) problems.push('paths 和 path 只能给一个');
    const paging = readPagingOf(raw);
    problems.push(...paging.problems);
    const items = parsePathBatchItems(paths, READ_BATCH_MAX, 'paths');
    if (!items.ok) return items;
    if (problems.length > 0) return argumentError(problems);
    return {
        ok: true,
        value: { items: items.value, offset: paging.offset, limit: paging.limit, workspace: raw.workspace },
    };
};

export interface WorkspaceListArgs {
    /** Canonical `dir/` prefix; empty = whole workspace */
    readonly prefix: string;
}

export const parseWorkspaceListArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceListArgs> => {
    const rawPrefix = raw.prefix;
    if (rawPrefix !== undefined && rawPrefix !== null && typeof rawPrefix !== 'string') {
        return { ok: false, error: '参数有误：prefix 要传字符串，如 widgets/。' };
    }
    const prefix = normalizeWorkspacePrefix(typeof rawPrefix === 'string' ? rawPrefix : undefined);
    return prefix.ok ? { ok: true, value: { prefix: prefix.path } } : { ok: false, error: prefix.error };
};

export interface WorkspaceEditArgs {
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll: boolean;
}

export const parseWorkspaceEditArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceEditArgs> => {
    const path = pathArg(raw.path);
    if (!path.ok) return path;
    const oldString = textArg(raw.old_string, 'old_string');
    if (!oldString.ok) return oldString;
    const newString = textArg(raw.new_string, 'new_string');
    if (!newString.ok) return newString;
    const replaceAll = boolArg(raw.replace_all, 'replace_all');
    if (!replaceAll.ok) return replaceAll;
    return {
        ok: true,
        value: {
            path: path.value,
            oldString: oldString.value,
            newString: newString.value,
            replaceAll: replaceAll.value,
        },
    };
};

export type WorkspaceEditBatchItem =
    | {
          readonly ok: true;
          /** The item's own `workspace` selector, resolved by the tool */
          readonly workspace: unknown;
          readonly args: WorkspaceEditArgs;
      }
    | BatchItemFailure;

const parseEditBatchItem = (raw: Readonly<Record<string, unknown>>, index: number): WorkspaceEditBatchItem => {
    const label = itemLabel(raw.path, index);
    const path = pathArg(raw.path);
    if (!path.ok) return { ok: false, label, error: path.error };
    const oldString = textArg(raw.old_string, 'old_string');
    if (!oldString.ok) return { ok: false, label, error: oldString.error };
    const newString = textArg(raw.new_string, 'new_string');
    if (!newString.ok) return { ok: false, label, error: newString.error };
    const replaceAll = boolArg(raw.replace_all, 'replace_all');
    if (!replaceAll.ok) return { ok: false, label, error: replaceAll.error };
    return {
        ok: true,
        workspace: raw.workspace,
        args: {
            path: path.value,
            oldString: oldString.value,
            newString: newString.value,
            replaceAll: replaceAll.value,
        },
    };
};

/**
 * The `edits` form of workspace_edit: every item runs on the file state the
 * previous one left, in list order, so two edits of one file compose.
 */
export const parseWorkspaceEditBatchArgs = (
    raw: Readonly<Record<string, unknown>>
): Parsed<readonly WorkspaceEditBatchItem[]> => {
    const edits = raw.edits;
    if (!Array.isArray(edits)) {
        return argumentError(['edits 要传数组，每项是 { path, old_string, new_string, replace_all?, workspace? }']);
    }
    const problems: string[] = [];
    if (hasText(raw.path)) problems.push('edits 和 path 只能给一个');
    if (hasText(raw.old_string)) problems.push('edits 和 old_string 只能给一个');
    if (hasText(raw.new_string)) problems.push('edits 和 new_string 只能给一个');
    if (raw.replace_all === true) {
        problems.push('edits 形态下 replace_all 写在每一项里（顶层的只用于单文件形态）');
    }
    if (typeof raw.workspace === 'string' && raw.workspace.trim() !== '') {
        problems.push('edits 形态下 workspace 写在每一项里（顶层的只用于单文件形态）');
    }
    if (edits.length === 0) problems.push('edits 是空的：至少改 1 处');
    if (edits.length > EDIT_BATCH_MAX) problems.push(`edits 最多 ${EDIT_BATCH_MAX} 项（现在 ${edits.length} 项）`);
    const nonObject = edits.findIndex((item) => !isRecord(item));
    if (nonObject >= 0) problems.push(`第 ${nonObject + 1} 项不是对象，每项要写成 { path, old_string, new_string }`);
    if (problems.length > 0) return argumentError(problems);
    const items: WorkspaceEditBatchItem[] = [];
    for (const [index, item] of edits.entries()) {
        if (!isRecord(item)) continue;
        items.push(parseEditBatchItem(item, index));
    }
    return { ok: true, value: items };
};

export interface WorkspaceDeleteArgs {
    readonly path: string;
}

export const parseWorkspaceDeleteArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceDeleteArgs> => {
    const path = pathArg(raw.path);
    return path.ok ? { ok: true, value: { path: path.value } } : path;
};

export type PreviewTheme = 'light' | 'dark';

export interface WorkspacePreviewArgs {
    readonly path: string;
    readonly theme: PreviewTheme;
}

export const parseWorkspacePreviewArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspacePreviewArgs> => {
    const path = pathArg(raw.path);
    if (!path.ok) return path;
    const theme = raw.theme;
    if (theme !== undefined && theme !== null && theme !== 'light' && theme !== 'dark') {
        return { ok: false, error: 'theme 只能是 "light" 或 "dark"。' };
    }
    return { ok: true, value: { path: path.value, theme: theme === 'dark' ? 'dark' : 'light' } };
};

export interface WorkspacePreviewBatchArgs {
    readonly items: readonly WorkspacePathBatchItem[];
    /** Shared by every draft of the batch */
    readonly theme: PreviewTheme;
    /** The workspace selector shared by the whole batch */
    readonly workspace: unknown;
}

export const parseWorkspacePreviewBatchArgs = (
    raw: Readonly<Record<string, unknown>>
): Parsed<WorkspacePreviewBatchArgs> => {
    const paths = raw.paths;
    if (!Array.isArray(paths)) {
        return argumentError(['paths 要传字符串数组，如 ["widgets/card.html","widgets/card-a2ui.json"]']);
    }
    const problems: string[] = [];
    if (hasText(raw.path)) problems.push('paths 和 path 只能给一个');
    const theme = raw.theme;
    if (theme !== undefined && theme !== null && theme !== 'light' && theme !== 'dark') {
        problems.push('theme 只能是 "light" 或 "dark"');
    }
    const items = parsePathBatchItems(paths, PREVIEW_BATCH_MAX, 'paths');
    if (!items.ok) return items;
    if (problems.length > 0) return argumentError(problems);
    return {
        ok: true,
        value: { items: items.value, theme: theme === 'dark' ? 'dark' : 'light', workspace: raw.workspace },
    };
};

/** Longest literal a find may search for; keeps the scan and the result message bounded */
export const FIND_QUERY_MAX_CHARS = 200;

export interface WorkspaceFindArgs {
    readonly query: string;
    /** Exact file to search; null = the whole conversation, filtered by prefix */
    readonly path: string | null;
    /** Canonical `dir/` prefix; empty = the whole conversation */
    readonly prefix: string;
    readonly caseSensitive: boolean;
}

export const parseWorkspaceFindArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceFindArgs> => {
    const query = textArg(raw.query, 'query');
    if (!query.ok) return query;
    if (query.value.trim() === '') {
        return { ok: false, error: 'query 不能为空；要搜什么就传什么，如 "NEON" 或 "标题"。' };
    }
    if (Array.from(query.value).length > FIND_QUERY_MAX_CHARS) {
        return { ok: false, error: `query 最多 ${FIND_QUERY_MAX_CHARS} 字符。` };
    }
    let path: string | null = null;
    if (raw.path !== undefined && raw.path !== null) {
        const parsedPath = pathArg(raw.path);
        if (!parsedPath.ok) return parsedPath;
        path = parsedPath.value;
    }
    let prefix = '';
    if (raw.prefix !== undefined && raw.prefix !== null) {
        const text = textArg(raw.prefix, 'prefix');
        if (!text.ok) return text;
        const parsedPrefix = normalizeWorkspacePrefix(text.value);
        if (!parsedPrefix.ok) return parsedPrefix;
        prefix = parsedPrefix.path;
    }
    if (path !== null && prefix !== '') {
        return { ok: false, error: 'path 和 prefix 只能给一个：搜一个文件用 path，搜一个目录用 prefix。' };
    }
    const caseSensitive = boolArg(raw.case_sensitive, 'case_sensitive');
    if (!caseSensitive.ok) return caseSensitive;
    return { ok: true, value: { query: query.value, path, prefix, caseSensitive: caseSensitive.value } };
};

export interface WorkspaceCopyArgs {
    readonly from: string;
    readonly to: string;
}

export const parseWorkspaceCopyArgs = (raw: Readonly<Record<string, unknown>>): Parsed<WorkspaceCopyArgs> => {
    const from = pathArg(raw.path);
    if (!from.ok) return from;
    const to = pathArg(raw.new_path, 'new_path');
    if (!to.ok) return to;
    if (from.value === to.value) {
        return { ok: false, error: 'path 和 new_path 相同；复制要换一个新路径，如 widgets/card-v1.html。' };
    }
    return { ok: true, value: { from: from.value, to: to.value } };
};

export interface LeaveHandoffArgs {
    readonly content: string;
}

/** The handoff tool takes one body; the path is fixed and every write replaces the old note */
export const parseLeaveHandoffArgs = (raw: Readonly<Record<string, unknown>>): Parsed<LeaveHandoffArgs> => {
    const content = textArg(raw.content, 'content');
    if (!content.ok) return content;
    if (content.value.trim() === '') {
        return { ok: false, error: '交接内容为空；本轮已无法补救，下一条回复请重新写交接。' };
    }
    return { ok: true, value: { content: content.value } };
};
