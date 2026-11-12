/**
 * The model workspace: a virtual text file system per conversation, stored in
 * SQLite.
 *
 * A conversation is one reply-tree root (`conversationRootId`), so every thread
 * gets its own workspace and starts empty; rows appear on the first write. The
 * hourly `clearExpiredData` deletes rows whose `lastUsedAt` is older than a
 * week, the same window as messages and reply versions.
 *
 * Everything here is SQL on `workspace_files`: no disk paths, no network, no
 * execution. The reply tools own the model-facing wording; this module owns the
 * invariants (path normalization, quotas, atomic writes, LRU refresh).
 */
import { Op, type Transaction } from '@sequelize/core';
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { WorkspaceFile } from '../db/workspaceFileDTO.js';
import { formatBytes, mimeForFileName } from '../shared/file-name.js';

/** How much one conversation's workspace may hold (built from the tool config per reply) */
export interface WorkspaceQuota {
    readonly maxFileBytes: number;
    readonly maxConversationBytes: number;
    readonly maxFiles: number;
    readonly maxGlobalBytes: number;
}

/** One file as the manifest and `workspace_list` show it (never the content) */
export interface WorkspaceFileInfo {
    readonly path: string;
    readonly sizeBytes: number;
    readonly summary: string;
    readonly mimeType: string;
    readonly updatedAt: Date;
}

export interface WorkspaceUsage {
    readonly fileCount: number;
    readonly totalBytes: number;
}

export interface WorkspaceSnapshot {
    readonly files: readonly WorkspaceFileInfo[];
    readonly usage: WorkspaceUsage;
}

/** A file with its bytes, for `workspace_read` and the delivery tools */
export interface WorkspaceFileContent {
    readonly id: number;
    readonly path: string;
    readonly content: string;
    readonly sizeBytes: number;
    readonly mimeType: string;
    readonly updatedAt: Date;
}

export type WorkspaceResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

/** Path limits: enough for `widgets/card.html`, not a file-system escape hatch */
export const MAX_PATH_CHARS = 128;
export const MAX_PATH_SEGMENT_CHARS = 64;
export const MAX_PATH_DEPTH = 3;

/** The first line the manifest shows; short enough to keep 20 files cheap */
const SUMMARY_MAX_CHARS = 120;

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// oxlint-disable-next-line no-control-regex -- a global regex keeps lastIndex between calls
const CONTROL_CHAR_TEST = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RUN = /\s+/g;

export type WorkspacePathResult =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly error: string };

const pathError = (detail: string): WorkspacePathResult => ({
    ok: false,
    error: `${detail}；路径要写成相对路径，如 widgets/card.html、notes/plan.md。`,
});

/** Normalize a model-supplied workspace path; rejects anything that is not a plain relative path */
export const normalizeWorkspacePath = (raw: string): WorkspacePathResult => {
    const trimmed = raw.trim();
    if (trimmed === '') return pathError('路径为空');
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return pathError('不能是绝对路径');
    if (trimmed.includes('\\')) return pathError('路径分隔符只能用 /');
    if (/^[A-Za-z]:/.test(trimmed)) return pathError('不能带盘符');
    if (trimmed.startsWith('~')) return pathError('不能用 ~ 开头');

    const segments = trimmed.split('/');
    const cleaned: string[] = [];
    for (const segment of segments) {
        if (segment === '' || segment === '.') return pathError('路径里有空目录段');
        if (segment === '..') return pathError('路径不能包含 ..');
        if (CONTROL_CHAR_TEST.test(segment)) return pathError('路径不能包含控制字符');
        if (Array.from(segment).length > MAX_PATH_SEGMENT_CHARS) {
            return pathError(`目录/文件名超过 ${MAX_PATH_SEGMENT_CHARS} 字符`);
        }
        cleaned.push(segment);
    }
    if (cleaned.length > MAX_PATH_DEPTH) return pathError(`目录最多 ${MAX_PATH_DEPTH} 层`);

    const path = cleaned.join('/');
    if (Array.from(path).length > MAX_PATH_CHARS) return pathError(`路径超过 ${MAX_PATH_CHARS} 字符`);
    return { ok: true, path };
};

/**
 * Normalize a `workspace_list` prefix: empty means the whole workspace; a
 * trailing `/` is allowed and dropped. Returns the canonical `dir/` form.
 */
export const normalizeWorkspacePrefix = (raw: string | undefined): WorkspacePathResult => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return { ok: true, path: '' };
    const withoutSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
    const normalized = normalizeWorkspacePath(withoutSlash);
    if (!normalized.ok) return normalized;
    return { ok: true, path: `${normalized.path}/` };
};

/** First non-empty line, control characters removed, capped — the manifest's one-liner */
export const summarizeWorkspaceContent = (content: string): string => {
    const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
    const cleaned = firstLine.replace(CONTROL_CHARS, ' ').replace(WHITESPACE_RUN, ' ').trim();
    return Array.from(cleaned).slice(0, SUMMARY_MAX_CHARS).join('');
};

/** The path a `workspace_list` prefix query keeps */
const pathMatchesPrefix = (path: string, prefix: string): boolean =>
    prefix === '' || path.startsWith(prefix);

/** `11-11 12:04` in the deployment timezone; deterministic between requests */
export const formatWorkspaceTime = (date: Date): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const valueOf = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}`;
};

const toInfo = (row: WorkspaceFile): WorkspaceFileInfo => ({
    path: row.path,
    sizeBytes: row.sizeBytes,
    summary: row.summary,
    mimeType: row.mimeType,
    updatedAt: row.updatedAt,
});

const toUsage = (rows: readonly WorkspaceFile[]): WorkspaceUsage => ({
    fileCount: rows.length,
    totalBytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
});

/** Rows of one conversation, newest first, without their content */
const loadRows = async (chatId: number, conversationRootId: number): Promise<WorkspaceFile[]> =>
    WorkspaceFile.findAll({
        where: { chatId, conversationRootId },
        attributes: ['path', 'sizeBytes', 'summary', 'mimeType', 'updatedAt'],
        order: [['updatedAt', 'DESC'], ['path', 'ASC']],
    });

/** One conversation's files (optionally under `prefix`) plus the whole usage */
export const listWorkspaceFiles = async (
    chatId: number,
    conversationRootId: number,
    prefix = ''
): Promise<WorkspaceSnapshot> => {
    const rows = await loadRows(chatId, conversationRootId);
    return {
        files: rows.filter((row) => pathMatchesPrefix(row.path, prefix)).map(toInfo),
        usage: toUsage(rows),
    };
};

/** The manifest needs usage + newest files of several conversations in one query */
export const loadWorkspaceSnapshots = async (
    chatId: number,
    conversationRootIds: readonly number[]
): Promise<Map<number, WorkspaceSnapshot>> => {
    const snapshots = new Map<number, WorkspaceSnapshot>();
    if (conversationRootIds.length === 0) return snapshots;
    const rows = await WorkspaceFile.findAll({
        where: { chatId, conversationRootId: { [Op.in]: [...conversationRootIds] } },
        attributes: ['conversationRootId', 'path', 'sizeBytes', 'summary', 'mimeType', 'updatedAt'],
        order: [['updatedAt', 'DESC'], ['path', 'ASC']],
    });
    const byRoot = new Map<number, WorkspaceFile[]>();
    for (const row of rows) {
        const list = byRoot.get(row.conversationRootId);
        if (list) list.push(row);
        else byRoot.set(row.conversationRootId, [row]);
    }
    for (const conversationRootId of conversationRootIds) {
        const rootRows = byRoot.get(conversationRootId) ?? [];
        snapshots.set(conversationRootId, {
            files: rootRows.map(toInfo),
            usage: toUsage(rootRows),
        });
    }
    return snapshots;
};

/** One file with its text; null when it does not exist */
export const readWorkspaceFile = async (
    chatId: number,
    conversationRootId: number,
    path: string
): Promise<WorkspaceFileContent | null> => {
    const row = await WorkspaceFile.findOne({ where: { chatId, conversationRootId, path } });
    if (row === null) return null;
    return {
        id: row.id,
        path: row.path,
        content: row.content.toString('utf8'),
        sizeBytes: row.sizeBytes,
        mimeType: row.mimeType,
        updatedAt: row.updatedAt,
    };
};

/**
 * The text of several files of one conversation in a single query, keyed by
 * path; `workspace_list` uses it to measure widget drafts without a query per
 * file. Paths that do not exist are simply absent from the map.
 */
export const loadWorkspaceContents = async (
    chatId: number,
    conversationRootId: number,
    paths: readonly string[]
): Promise<Map<string, string>> => {
    const contents = new Map<string, string>();
    if (paths.length === 0) return contents;
    const rows = await WorkspaceFile.findAll({
        where: { chatId, conversationRootId, path: { [Op.in]: [...paths] } },
        attributes: ['path', 'content'],
    });
    for (const row of rows) contents.set(row.path, row.content.toString('utf8'));
    return contents;
};

/**
 * Refresh the LRU clock of one file, at most once an hour per file. A read is
 * a write here; the throttle keeps a browsing model from hammering the single
 * SQLite writer.
 */
export const touchWorkspaceFile = async (id: number, now: Date = new Date()): Promise<void> => {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await withBusyRetry(
        () =>
            WorkspaceFile.update(
                { lastUsedAt: now },
                { where: { id, lastUsedAt: { [Op.lt]: oneHourAgo } } }
            ),
        `workspace touch ${id}`
    );
};

/** Quota context of one write: the conversation's current totals and the global total */
const usageExcluding = async (
    chatId: number,
    conversationRootId: number,
    excludeId: number | null,
    transaction: Transaction
): Promise<{ fileCount: number; totalBytes: number; globalBytes: number }> => {
    const exclude = excludeId === null ? {} : { id: { [Op.ne]: excludeId } };
    const [fileCount, totalBytes, globalBytes] = await Promise.all([
        WorkspaceFile.count({ where: { chatId, conversationRootId, ...exclude }, transaction }),
        WorkspaceFile.sum('sizeBytes', { where: { chatId, conversationRootId, ...exclude }, transaction }),
        WorkspaceFile.sum('sizeBytes', { where: exclude, transaction }),
    ]);
    return {
        fileCount: Number(fileCount ?? 0),
        totalBytes: Number(totalBytes ?? 0),
        globalBytes: Number(globalBytes ?? 0),
    };
};

const quotaError = (
    quota: WorkspaceQuota,
    usage: { totalBytes: number; fileCount: number; globalBytes: number },
    neededBytes: number
): string => {
    const lines = [
        `工作区配额不够：本会话已用 ${formatBytes(usage.totalBytes)} / ${formatBytes(quota.maxConversationBytes)}、` +
            `${usage.fileCount} / ${quota.maxFiles} 个文件。`,
    ];
    if (usage.globalBytes + neededBytes > quota.maxGlobalBytes) {
        lines.push(
            `整个工作区（所有会话合计）已用 ${formatBytes(usage.globalBytes)} / ` +
                `${formatBytes(quota.maxGlobalBytes)}，删掉本会话的草稿不一定能腾出空间。`
        );
    }
    lines.push('先用 workspace_list 看看，再用 workspace_delete 删掉不用的草稿。');
    return lines.join('');
};

export interface WorkspaceWriteInput {
    readonly chatId: number;
    readonly conversationRootId: number;
    readonly path: string;
    readonly content: string;
    readonly append: boolean;
    readonly overwrite: boolean;
    readonly quota: WorkspaceQuota;
}

export interface WorkspaceWriteOk {
    readonly path: string;
    readonly sizeBytes: number;
    /** The file's text after the write (an append returns the whole file) */
    readonly content: string;
    /** The row did not exist before this call */
    readonly created: boolean;
    readonly fileCount: number;
    readonly totalBytes: number;
    /** Bytes replaced by an overwrite; null when the file was created or appended to */
    readonly replacedBytes: number | null;
}

/** Write (create / overwrite / append) one file; quotas and the row change share a transaction */
export const writeWorkspaceFile = async (
    input: WorkspaceWriteInput
): Promise<WorkspaceResult<WorkspaceWriteOk>> => {
    const { chatId, conversationRootId, path, content, append, overwrite, quota } = input;
    const bytes = Buffer.from(content, 'utf8');

    return withBusyRetry(
        () =>
            sequelize.transaction(async (transaction): Promise<WorkspaceResult<WorkspaceWriteOk>> => {
                const existing = await WorkspaceFile.findOne({
                    where: { chatId, conversationRootId, path },
                    transaction,
                });
                if (existing !== null && !append && !overwrite) {
                    return {
                        ok: false,
                        error:
                            `工作区里已经有《${path}》（${formatBytes(existing.sizeBytes)}）。` +
                            '要整体替换传 overwrite=true，要追加传 append=true，要局部修改用 workspace_edit。',
                    };
                }

                const nextContent =
                    append && existing !== null
                        ? Buffer.concat([existing.content, bytes])
                        : bytes;
                if (nextContent.length > quota.maxFileBytes) {
                    return {
                        ok: false,
                        error:
                            `单个文件上限 ${formatBytes(quota.maxFileBytes)}，这次写出来是 ` +
                            `${formatBytes(nextContent.length)}；请精简内容或拆成多个文件。`,
                    };
                }

                const usage = await usageExcluding(
                    chatId,
                    conversationRootId,
                    existing === null ? null : existing.id,
                    transaction
                );
                const addsFile = existing === null ? 1 : 0;
                if (
                    usage.fileCount + addsFile > quota.maxFiles ||
                    usage.totalBytes + nextContent.length > quota.maxConversationBytes ||
                    usage.globalBytes + nextContent.length > quota.maxGlobalBytes
                ) {
                    return { ok: false, error: quotaError(quota, usage, nextContent.length) };
                }

                const now = new Date();
                const nextText = nextContent.toString('utf8');
                // Appending to a non-empty file never changes its first line, so
                // the manifest summary must survive it; overwrite re-derives it
                // (an overwrite to empty content clears it).
                const summary =
                    append && existing !== null && existing.sizeBytes > 0
                        ? existing.summary
                        : summarizeWorkspaceContent(nextText);
                const mimeType = mimeForFileName(path);
                if (existing !== null) {
                    const replacedBytes = append ? null : existing.sizeBytes;
                    await existing.update(
                        {
                            content: nextContent,
                            sizeBytes: nextContent.length,
                            summary,
                            mimeType,
                            updatedAt: now,
                            lastUsedAt: now,
                        },
                        { transaction }
                    );
                    return {
                        ok: true,
                        path,
                        sizeBytes: nextContent.length,
                        content: nextText,
                        created: false,
                        // usage excludes this row; the conversation still holds it
                        fileCount: usage.fileCount + 1,
                        totalBytes: usage.totalBytes + nextContent.length,
                        replacedBytes,
                    };
                }

                await WorkspaceFile.create(
                    {
                        chatId,
                        conversationRootId,
                        path,
                        content: nextContent,
                        sizeBytes: nextContent.length,
                        summary,
                        mimeType,
                        createdAt: now,
                        updatedAt: now,
                        lastUsedAt: now,
                    },
                    { transaction }
                );
                return {
                    ok: true,
                    path,
                    sizeBytes: nextContent.length,
                    content: nextText,
                    created: true,
                    fileCount: usage.fileCount + 1,
                    totalBytes: usage.totalBytes + nextContent.length,
                    replacedBytes: null,
                };
            }),
        `workspace write ${chatId}/${conversationRootId}/${path}`
    );
};

/** First few lines around the best match, for an `old_string` that was not found */
const closestLinesOf = (
    content: string,
    target: string
): { readonly lineNumber: number; readonly block: string } | null => {
    const lines = content.split('\n');
    const wanted = (target.split('\n')[0] ?? '').trim();
    if (wanted === '') return null;
    let bestIndex = 0;
    let bestScore = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').trim();
        let score = 0;
        const limit = Math.min(line.length, wanted.length);
        while (score < limit && line[score] === wanted[score]) score += 1;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    const start = Math.max(0, bestIndex - 1);
    const end = Math.min(lines.length, bestIndex + 2);
    const shown: string[] = [];
    for (let index = start; index < end; index += 1) {
        shown.push(`${index + 1}| ${Array.from(lines[index] ?? '').slice(0, 160).join('')}`);
    }
    return { lineNumber: bestIndex + 1, block: shown.join('\n') };
};

export interface WorkspaceEditInput {
    readonly chatId: number;
    readonly conversationRootId: number;
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll: boolean;
    readonly quota: WorkspaceQuota;
}

export interface WorkspaceEditOk {
    readonly path: string;
    readonly replacements: number;
    readonly sizeBytes: number;
    /** The file's text after the edit */
    readonly content: string;
}

/** Exact-string edit, all-or-nothing; quotas checked with the write */
export const editWorkspaceFile = async (
    input: WorkspaceEditInput
): Promise<WorkspaceResult<WorkspaceEditOk>> => {
    const { chatId, conversationRootId, path, oldString, newString, replaceAll, quota } = input;
    if (oldString === '') {
        return { ok: false, error: 'old_string 不能为空；要整体重写用 workspace_write(overwrite=true)。' };
    }

    return withBusyRetry(
        () =>
            sequelize.transaction(async (transaction): Promise<WorkspaceResult<WorkspaceEditOk>> => {
                const existing = await WorkspaceFile.findOne({
                    where: { chatId, conversationRootId, path },
                    transaction,
                });
                if (existing === null) {
                    return {
                        ok: false,
                        error: `工作区里没有《${path}》；用 workspace_list 看看现有文件，或先 workspace_write 创建。`,
                    };
                }

                const content = existing.content.toString('utf8');
                const occurrences = content.split(oldString).length - 1;
                if (occurrences === 0) {
                    const closest = closestLinesOf(content, oldString);
                    return {
                        ok: false,
                        error:
                            `《${path}》里找不到这段 old_string。` +
                            (closest === null
                                ? ''
                                : `最接近的内容在第 ${closest.lineNumber} 行附近：\n${closest.block}\n`) +
                            '先 workspace_read 读一遍原文，再拿完全一致（含缩进）的片段重试。',
                    };
                }
                if (occurrences > 1 && !replaceAll) {
                    return {
                        ok: false,
                        error:
                            `old_string 在《${path}》里出现了 ${occurrences} 次，无法确定改哪一处；` +
                            '请多带一点上下文让它唯一，或传 replace_all=true 全部替换。',
                    };
                }

                const nextContent = replaceAll
                    ? content.split(oldString).join(newString)
                    : content.replace(oldString, () => newString);
                const bytes = Buffer.from(nextContent, 'utf8');
                if (bytes.length > quota.maxFileBytes) {
                    return {
                        ok: false,
                        error: `单个文件上限 ${formatBytes(quota.maxFileBytes)}，改完是 ${formatBytes(bytes.length)}；请精简内容。`,
                    };
                }

                const usage = await usageExcluding(chatId, conversationRootId, existing.id, transaction);
                if (
                    usage.totalBytes + bytes.length > quota.maxConversationBytes ||
                    usage.globalBytes + bytes.length > quota.maxGlobalBytes
                ) {
                    return { ok: false, error: quotaError(quota, usage, bytes.length) };
                }

                const now = new Date();
                await existing.update(
                    {
                        content: bytes,
                        sizeBytes: bytes.length,
                        summary: summarizeWorkspaceContent(nextContent),
                        updatedAt: now,
                        lastUsedAt: now,
                    },
                    { transaction }
                );
                return {
                    ok: true,
                    path,
                    replacements: replaceAll ? occurrences : 1,
                    sizeBytes: bytes.length,
                    content: nextContent,
                };
            }),
        `workspace edit ${chatId}/${conversationRootId}/${path}`
    );
};

export interface WorkspaceDeleteOk {
    readonly path: string;
    readonly freedBytes: number;
    readonly fileCount: number;
    readonly totalBytes: number;
}

/** Delete one file; the freed bytes are reported back to the model */
export const deleteWorkspaceFile = async (
    chatId: number,
    conversationRootId: number,
    path: string
): Promise<WorkspaceResult<WorkspaceDeleteOk>> =>
    withBusyRetry(
        () =>
            sequelize.transaction(async (transaction): Promise<WorkspaceResult<WorkspaceDeleteOk>> => {
                const existing = await WorkspaceFile.findOne({
                    where: { chatId, conversationRootId, path },
                    transaction,
                });
                if (existing === null) {
                    return {
                        ok: false,
                        error: `工作区里没有《${path}》；用 workspace_list 看看现有文件。`,
                    };
                }
                const freedBytes = existing.sizeBytes;
                await existing.destroy({ transaction });
                const remaining = await WorkspaceFile.findAll({
                    where: { chatId, conversationRootId },
                    attributes: ['sizeBytes'],
                    transaction,
                });
                return {
                    ok: true,
                    path,
                    freedBytes,
                    fileCount: remaining.length,
                    totalBytes: remaining.reduce((total, row) => total + row.sizeBytes, 0),
                };
            }),
        `workspace delete ${chatId}/${conversationRootId}/${path}`
    );

/** One `workspace_find` hit: the line is already capped for display */
export interface WorkspaceFindHit {
    readonly path: string;
    readonly lineNumber: number;
    readonly line: string;
}

export interface WorkspaceFindInput {
    readonly query: string;
    /** Exact file to search; null = the whole conversation (filtered by prefix) */
    readonly path: string | null;
    /** Canonical `dir/` prefix; empty = the whole conversation */
    readonly prefix: string;
    readonly caseSensitive: boolean;
    /** Hits shown, characters of the rendered `path:line| text` lines, and one line's cap */
    readonly maxHits: number;
    readonly maxChars: number;
    readonly maxLineChars: number;
}

export interface WorkspaceFindOk {
    readonly hits: readonly WorkspaceFindHit[];
    /** Every match, including the ones the caps kept out */
    readonly totalHits: number;
    readonly scannedFiles: number;
    readonly truncated: boolean;
}

/** Cap one matched line so a single long line cannot eat the whole budget */
const findLineOf = (line: string, maxChars: number): string => {
    const chars = Array.from(line);
    return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : line;
};

/**
 * Literal substring search across one conversation's files, line by line.
 *
 * The content is scanned in memory: one conversation is capped at 10 MB and
 * 100 files, so a search is a single query plus a linear scan. Only files with
 * a hit refresh their LRU clock — scanning past a file is not using it.
 */
export const findWorkspaceFiles = async (
    chatId: number,
    conversationRootId: number,
    input: WorkspaceFindInput
): Promise<WorkspaceFindOk> => {
    const rows = await WorkspaceFile.findAll({
        where: { chatId, conversationRootId },
        attributes: ['id', 'path', 'content'],
        order: [['path', 'ASC']],
    });
    const files = rows.filter((row) =>
        input.path === null ? pathMatchesPrefix(row.path, input.prefix) : row.path === input.path
    );
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const hits: WorkspaceFindHit[] = [];
    const matchedIds: number[] = [];
    let totalHits = 0;
    let usedChars = 0;
    for (const file of files) {
        const content = file.content.toString('utf8');
        let found = false;
        let lineNumber = 0;
        for (const rawLine of content.split('\n')) {
            lineNumber += 1;
            const haystack = input.caseSensitive ? rawLine : rawLine.toLowerCase();
            if (!haystack.includes(needle)) continue;
            totalHits += 1;
            found = true;
            if (hits.length >= input.maxHits) continue;
            const line = findLineOf(rawLine, input.maxLineChars);
            // Budget the rendered line, including the `path:line| ` prefix
            const renderedLength = file.path.length + String(lineNumber).length + 2 + line.length;
            if (usedChars + renderedLength > input.maxChars) continue;
            usedChars += renderedLength + 1;
            hits.push({ path: file.path, lineNumber, line });
        }
        if (found) matchedIds.push(file.id);
    }
    for (const id of matchedIds) {
        await touchWorkspaceFile(id).catch((error: unknown) => {
            console.warn('[workspace_find] lastUsedAt refresh failed:', error);
        });
    }
    return { hits, totalHits, scannedFiles: files.length, truncated: totalHits > hits.length };
};

export interface WorkspaceCopyInput {
    readonly from: string;
    readonly to: string;
    readonly quota: WorkspaceQuota;
}

export interface WorkspaceCopyOk {
    readonly from: string;
    readonly to: string;
    readonly sizeBytes: number;
    readonly fileCount: number;
    readonly totalBytes: number;
}

/**
 * Copy one file to a new path inside the same conversation; never overwrites.
 *
 * The copy is a plain row duplicate (content bytes, summary, MIME type) with
 * the quotas checked in the same transaction; reading the source also refreshes
 * its LRU clock. A model keeps a known-good version this way before a risky
 * edit without re-outputting the whole file.
 */
export const copyWorkspaceFile = async (
    chatId: number,
    conversationRootId: number,
    input: WorkspaceCopyInput
): Promise<WorkspaceResult<WorkspaceCopyOk>> => {
    const { from, to, quota } = input;
    return withBusyRetry(
        () =>
            sequelize.transaction(async (transaction): Promise<WorkspaceResult<WorkspaceCopyOk>> => {
                const source = await WorkspaceFile.findOne({
                    where: { chatId, conversationRootId, path: from },
                    transaction,
                });
                if (source === null) {
                    return {
                        ok: false,
                        error: `工作区里没有《${from}》；用 workspace_list 看看现有文件，或用 workspace_find 搜内容。`,
                    };
                }
                const existing = await WorkspaceFile.findOne({
                    where: { chatId, conversationRootId, path: to },
                    transaction,
                });
                if (existing !== null) {
                    return {
                        ok: false,
                        error:
                            `工作区里已经有《${to}》（${formatBytes(existing.sizeBytes)}）。` +
                            '换一个 new_path，或先 workspace_delete 目标，或直接改源文件。',
                    };
                }
                const usage = await usageExcluding(chatId, conversationRootId, null, transaction);
                if (
                    usage.fileCount + 1 > quota.maxFiles ||
                    usage.totalBytes + source.sizeBytes > quota.maxConversationBytes ||
                    usage.globalBytes + source.sizeBytes > quota.maxGlobalBytes
                ) {
                    return { ok: false, error: quotaError(quota, usage, source.sizeBytes) };
                }
                const now = new Date();
                await WorkspaceFile.create(
                    {
                        chatId,
                        conversationRootId,
                        path: to,
                        content: source.content,
                        sizeBytes: source.sizeBytes,
                        summary: source.summary,
                        mimeType: mimeForFileName(to),
                        createdAt: now,
                        updatedAt: now,
                        lastUsedAt: now,
                    },
                    { transaction }
                );
                await source.update({ lastUsedAt: now }, { transaction });
                return {
                    ok: true,
                    from,
                    to,
                    sizeBytes: source.sizeBytes,
                    fileCount: usage.fileCount + 1,
                    totalBytes: usage.totalBytes + source.sizeBytes,
                };
            }),
        `workspace copy ${chatId}/${conversationRootId}/${from}`
    );
};

/** Whole-workspace usage of one conversation; v1 has no panel page (D11), so only the offline suite calls it */
export const workspaceUsageOf = async (
    chatId: number,
    conversationRootId: number
): Promise<WorkspaceUsage> => {
    const rows = await loadRows(chatId, conversationRootId);
    return toUsage(rows);
};
