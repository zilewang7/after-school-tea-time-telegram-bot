/**
 * send_file arguments: the file name rules, the extension → MIME table and the
 * checks the model can fix in its next call.
 *
 * Pure functions so the offline suite can pin the wording and the table
 * without a Telegram client or a reply.
 */

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
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WHITESPACE_RUN = /\s+/g;

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
    ['md', 'text/markdown'],
    ['markdown', 'text/markdown'],
    ['txt', 'text/plain'],
    ['text', 'text/plain'],
    ['log', 'text/plain'],
    ['json', 'application/json'],
    ['csv', 'text/csv'],
    ['tsv', 'text/tab-separated-values'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
    ['xml', 'application/xml'],
    ['yaml', 'application/yaml'],
    ['yml', 'application/yaml'],
    ['toml', 'application/toml'],
    ['js', 'text/javascript'],
    ['mjs', 'text/javascript'],
    ['cjs', 'text/javascript'],
    ['css', 'text/css'],
    ['py', 'text/x-python'],
    ['sh', 'application/x-sh'],
    ['bash', 'application/x-sh'],
    ['sql', 'application/sql'],
    ['svg', 'image/svg+xml'],
    ['ini', 'text/plain'],
]);

/** The last extension of a name, lowercased; empty when it has none */
const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
};

/** MIME from the extension; text/plain for anything unknown (the content is text) */
export const mimeForFileName = (name: string): string =>
    MIME_BY_EXTENSION.get(extensionOf(name)) ?? 'text/plain';

/** `512 B`, `12.4 KB`, `1.5 MB` — the model and the chat both read this */
export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

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

export interface SendFileArgs {
    readonly fileName: string;
    readonly mimeType: string;
    readonly content: string;
    readonly append: boolean;
    /** Empty: the file goes out without a caption */
    readonly caption: string;
}

export type ParsedSendFileArgs =
    | { readonly ok: true; readonly args: SendFileArgs }
    | { readonly ok: false; readonly error: string };

const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

const parseText = (value: unknown, field: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } =>
    typeof value === 'string'
        ? { ok: true, text: value }
        : { ok: false, error: `参数有误：${field} 要传字符串` };

export const parseSendFileArgs = (rawArgs: Readonly<Record<string, unknown>>): ParsedSendFileArgs => {
    const rawName = rawArgs.file_name;
    if (typeof rawName !== 'string' || rawName.trim() === '') {
        return { ok: false, error: '参数有误：file_name 要传文件名，例如 SKILL.md' };
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

    const caption = rawArgs.caption;
    if (!isAbsent(caption) && typeof caption !== 'string') {
        return { ok: false, error: '参数有误：caption 要传字符串' };
    }

    return {
        ok: true,
        args: {
            fileName: name.name,
            mimeType: mimeForFileName(name.name),
            content: content.text,
            append: append === true,
            caption: typeof caption === 'string' ? caption : '',
        },
    };
};
