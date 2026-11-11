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

const pathArg = (raw: unknown): Parsed<string> => {
    const text = textArg(raw, 'path');
    if (!text.ok) return text;
    const normalized = normalizeWorkspacePath(text.value);
    return normalized.ok ? { ok: true, value: normalized.path } : { ok: false, error: normalized.error };
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
