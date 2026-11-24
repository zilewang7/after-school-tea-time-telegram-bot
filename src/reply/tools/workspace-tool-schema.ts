/**
 * Schema, description and dynamic status line of the merged `workspace` tool.
 *
 * Uses a flat object schema (no top-level oneOf/anyOf/allOf) so all 6 model
 * platforms accept it, while pruning `preview` and `theme` when preview is off.
 */
import { match } from 'ts-pattern';
import {
    EDIT_BATCH_MAX,
    READ_BATCH_MAX,
    READ_LIMIT_MAX,
    WRITE_BATCH_MAX,
} from './workspace-tool-args.js';

export const WORKSPACE_BASE_ACTIONS = [
    'list',
    'read',
    'write',
    'edit',
    'copy',
    'delete',
    'find',
] as const;

export const WORKSPACE_ALL_ACTIONS = [...WORKSPACE_BASE_ACTIONS, 'preview'] as const;

export type WorkspaceAction = (typeof WORKSPACE_ALL_ACTIONS)[number];

export const isWorkspaceAction = (value: unknown): value is WorkspaceAction =>
    typeof value === 'string' && WORKSPACE_ALL_ACTIONS.some((action) => action === value);

export const workspaceDescriptionOf = (previewEnabled: boolean): string =>
    `操作会话工作区草稿（7天清理；list/read/write/edit/copy/delete/find${previewEnabled ? '/preview' : ''}）。` +
    "批量/交接与协作规范见 load_skill(['workspace-usage'])。";

export const workspaceInputSchemaOf = (previewEnabled: boolean): Readonly<Record<string, unknown>> => ({
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: previewEnabled ? [...WORKSPACE_ALL_ACTIONS] : [...WORKSPACE_BASE_ACTIONS],
            description: '操作类型',
        },
        path: { type: 'string', description: '文件相对路径（最多3层目录）' },
        paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: READ_BATCH_MAX,
            description: previewEnabled ? '批量路径（read≤10 / preview≤3），与 path 互斥' : '批量路径（read≤10），与 path 互斥',
        },
        content: { type: 'string', description: 'write 写入的 UTF-8 文本' },
        append: { type: 'boolean', description: 'write 追加到末尾' },
        overwrite: { type: 'boolean', description: 'write 覆盖已存在文件' },
        files: {
            type: 'array',
            minItems: 1,
            maxItems: WRITE_BATCH_MAX,
            description: 'write 批量 [{path,content,append?,overwrite?,workspace?}]（≤10项/32K字）',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    append: { type: 'boolean' },
                    overwrite: { type: 'boolean' },
                    workspace: { type: 'string' },
                },
                required: ['path', 'content'],
            },
        },
        old_string: { type: 'string', description: 'edit 待替换原文（不含行号）' },
        new_string: { type: 'string', description: 'edit 替换后文本' },
        replace_all: { type: 'boolean', description: 'edit 替换全部出现' },
        edits: {
            type: 'array',
            minItems: 1,
            maxItems: EDIT_BATCH_MAX,
            description: 'edit 批量 [{path,old_string,new_string,replace_all?,workspace?}]（≤5项）',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    old_string: { type: 'string' },
                    new_string: { type: 'string' },
                    replace_all: { type: 'boolean' },
                    workspace: { type: 'string' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
        new_path: { type: 'string', description: 'copy 目标路径（不覆盖）' },
        prefix: { type: 'string', description: 'list/find 目录前缀，如 widgets/' },
        query: { type: 'string', description: 'find 字面量搜索词（≤200字）' },
        case_sensitive: { type: 'boolean', description: 'find 区分大小写' },
        offset: { type: 'integer', minimum: 1, description: 'read 起始行号（从1起）' },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: READ_LIMIT_MAX,
            description: 'read 行数（默认200/最大800）',
        },
        ...(previewEnabled
            ? {
                  theme: {
                      type: 'string',
                      enum: ['light', 'dark'],
                      description: 'preview 配色，默认 light',
                  },
              }
            : {}),
        workspace: { type: 'string', description: '会话工作区（省略=w1；w2…见清单）' },
    },
    required: ['action'],
});

export const workspaceStatusTextOf = (args: Readonly<Record<string, unknown>>): string =>
    match(args.action)
        .with('list', () => '📂 正在列工作区…')
        .with('read', () => '📖 正在读工作区文件…')
        .with('write', () => '📝 正在写工作区文件…')
        .with('edit', () => '✏️ 正在修改工作区文件…')
        .with('copy', () => '📋 正在复制工作区文件…')
        .with('delete', () => '🗑️ 正在删除工作区文件…')
        .with('find', () => '🔍 正在搜索工作区…')
        .with('preview', () => '🖼️ 正在渲染工作区预览…')
        .otherwise(() => '⚙️ 正在操作工作区…');
