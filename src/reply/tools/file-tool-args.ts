/**
 * send_file arguments: the file name rules, the extension → MIME table and the
 * checks the model can fix in its next call.
 *
 * Pure functions so the offline suite can pin the wording and the table
 * without a Telegram client or a reply.
 */
import { extensionOf, mimeForFileName } from '../../shared/file-name.js';
import { normalizeWorkspacePath } from '../../services/workspace-service.js';

// The extension → MIME table and the size format live in the shared layer: the
// workspace service (layer 2) needs them too, and it must not import reply.
export { formatBytes, mimeForFileName } from '../../shared/file-name.js';

/**
 * Hard cap of one file: 10 MB. The model's own output budget is the real
 * bound (1M output tokens is still under 4 MB of text); the cap only stops a
 * runaway call from filling the database.
 */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Telegram would rather not carry an empty name; the model may forget it */
export const DEFAULT_FILE_NAME = 'file.txt';

/** Long names are truncated (base first, extension kept) */
export const MAX_FILE_NAME_CHARS = 80;

/** Characters Telegram clients and Windows downloads all accept */
const ILLEGAL_NAME_CHARS = /[<>:"|?*]/g;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WHITESPACE_RUN = /\s+/g;

export type FileNameResult =
    | { readonly ok: true; readonly name: string }
    | { readonly ok: false; readonly error: string };

/** Keep the extension when the base has to be cut */
const truncateName = (name: string): string => {
    if (name.length <= MAX_FILE_NAME_CHARS) return name;
    const extension = extensionOf(name);
    const suffix = extension === '' ? '' : `.${extension}`;
    const base = extension === '' ? name : name.slice(0, name.length - suffix.length);
    return base.slice(0, Math.max(1, MAX_FILE_NAME_CHARS - suffix.length)) + suffix;
};

/**
 * The name the file goes out as. Path separators are refused instead of
 * guessed around: a model writing `src/main.ts` means a directory structure
 * this tool does not have, and silently flattening it would surprise it.
 */
export const sanitizeFileName = (raw: string): FileNameResult => {
    const trimmed = raw.trim();
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return { ok: false, error: '文件名不能包含路径分隔符，请只给文件名（如 SKILL.md）。' };
    }

    const cleaned = truncateName(
        trimmed
            .replace(CONTROL_CHARS, '')
            .replace(ILLEGAL_NAME_CHARS, '_')
            .replace(WHITESPACE_RUN, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '')
    );
    return { ok: true, name: cleaned === '' ? DEFAULT_FILE_NAME : cleaned };
};

/** The model wrote the bytes inline with the tool call */
export interface SendFileContentArgs {
    readonly mode: 'content';
    readonly fileName: string;
    readonly mimeType: string;
    readonly content: string;
    readonly append: boolean;
    /** Empty: the file goes out without a caption */
    readonly caption: string;
}

/** The bytes come from a workspace file (the draft workflow) */
export interface SendFileWorkspaceArgs {
    readonly mode: 'workspace';
    /** Normalized workspace path */
    readonly workspacePath: string;
    /** Sanitized delivery name; null = the path's basename */
    readonly fileName: string | null;
    readonly caption: string;
}

export type SendFileArgs = SendFileContentArgs | SendFileWorkspaceArgs;

export type ParsedSendFileArgs =
    | { readonly ok: true; readonly args: SendFileArgs }
    | { readonly ok: false; readonly error: string };

export interface ParseSendFileOptions {
    /** The workspace tools are offered this turn, so `workspace_path` is allowed */
    readonly workspace: boolean;
}

const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

const parseText = (value: unknown, field: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } =>
    typeof value === 'string'
        ? { ok: true, text: value }
        : { ok: false, error: `参数有误：${field} 要传字符串` };

export const parseSendFileArgs = (
    rawArgs: Readonly<Record<string, unknown>>,
    options: ParseSendFileOptions = { workspace: false }
): ParsedSendFileArgs => {
    const caption = rawArgs.caption;
    if (!isAbsent(caption) && typeof caption !== 'string') {
        return { ok: false, error: '参数有误：caption 要传字符串' };
    }
    const captionText = typeof caption === 'string' ? caption : '';

    // Workspace mode: exactly one of content / workspace_path.
    const rawWorkspacePath = rawArgs.workspace_path;
    if (!isAbsent(rawWorkspacePath)) {
        if (!options.workspace) {
            return {
                ok: false,
                error: 'workspace_path 需要工作区工具开启；当前这条回复没有工作区，请改用 content 直接写内容。',
            };
        }
        if (typeof rawWorkspacePath !== 'string' || rawWorkspacePath.trim() === '') {
            return { ok: false, error: '参数有误：workspace_path 要传工作区里的相对路径。' };
        }
        if (!isAbsent(rawArgs.content)) {
            return { ok: false, error: 'workspace_path 和 content 只能给一个：从工作区取文件时不要再传 content。' };
        }
        if (!isAbsent(rawArgs.append) && typeof rawArgs.append !== 'boolean') {
            return { ok: false, error: '参数有误：append 要传 true / false' };
        }
        if (rawArgs.append === true) {
            return { ok: false, error: 'workspace_path 模式不能带 append：工作区文件已经是完整内容。' };
        }
        const normalized = normalizeWorkspacePath(rawWorkspacePath);
        if (!normalized.ok) return { ok: false, error: normalized.error };

        if (!isAbsent(rawArgs.file_name) && typeof rawArgs.file_name !== 'string') {
            return { ok: false, error: '参数有误：file_name 要传文件名，例如 report.md' };
        }
        let deliveryName: string | null = null;
        if (typeof rawArgs.file_name === 'string' && rawArgs.file_name.trim() !== '') {
            const name = sanitizeFileName(rawArgs.file_name);
            if (!name.ok) return { ok: false, error: name.error };
            deliveryName = name.name;
        }
        return {
            ok: true,
            args: {
                mode: 'workspace',
                workspacePath: normalized.path,
                fileName: deliveryName,
                caption: captionText,
            },
        };
    }

    // `workspace` selects a conversation only in workspace_path mode; inline
    // content never touches the workspace, so a stray selector would be ignored.
    if (!isAbsent(rawArgs.workspace) && rawArgs.workspace !== '') {
        return {
            ok: false,
            error: 'workspace 只用于 workspace_path 模式；内联 content 不会写进工作区，要落草稿请先 workspace_write。',
        };
    }

    // Inline mode: the model writes the file content itself.
    const rawName = rawArgs.file_name;
    if (typeof rawName !== 'string' || rawName.trim() === '') {
        return { ok: false, error: '参数有误：file_name 要传文件名，例如 SKILL.md（从工作区发时改传 workspace_path）' };
    }
    const name = sanitizeFileName(rawName);
    if (!name.ok) return { ok: false, error: name.error };

    const content = parseText(rawArgs.content, 'content');
    if (!content.ok) return content;
    if (content.text.trim() === '') {
        return { ok: false, error: 'content 为空，文件里没有内容可写。' };
    }

    const append = rawArgs.append;
    if (!isAbsent(append) && typeof append !== 'boolean') {
        return { ok: false, error: '参数有误：append 要传 true / false' };
    }

    return {
        ok: true,
        args: {
            mode: 'content',
            fileName: name.name,
            mimeType: mimeForFileName(name.name),
            content: content.text,
            append: append === true,
            caption: captionText,
        },
    };
};
