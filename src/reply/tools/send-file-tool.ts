/**
 * send_file: the model writes a text file and the reply delivers it as a
 * Telegram document.
 *
 * The tool only assembles the content. Delivery happens after the reply text,
 * in the same branch as the image and sticker paths, so stop, retry, failure
 * fallback and version switching work for a file exactly as they do for a
 * picture. One file per reply: a second name is refused, appending continues
 * the same file.
 *
 * With the model workspace enabled, the bytes may also come from a workspace
 * file (`workspace_path`): that is the draft → send path, and the model no
 * longer has to reproduce a long file inside one tool call.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { baseNameOf, formatBytes } from '../../shared/file-name.js';
import { readWorkspaceFile, touchWorkspaceFile } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { FILE_MAX_BYTES, parseSendFileArgs, sanitizeFileName } from './file-tool-args.js';
import { imageToolError } from './image-tool-result.js';
import {
    ONE_ATTACHMENT_PER_REPLY,
    fileDeliveryOf,
    fileDraftBytes,
    type ReplyFileDraft,
    type ReplyMediaState,
} from './reply-media-state.js';
import { SEND_FILE_TOOL_NAME } from './tool-names.js';

const BASE_DESCRIPTION =
    '把你写的文本内容作为文件发到聊天（附在当前回复末尾，每条回复最多一个附件）。' +
    '适合装不进一条消息的成品长文：完整的 SKILL.md、代码文件、CSV/JSON 数据、报告等。' +
    '文件名由你决定，保留扩展名；内容是 UTF-8 文本；单份上限 10 MB，' +
    '可分多次调用用 append=true 追加。';

const WORKSPACE_DESCRIPTION =
    BASE_DESCRIPTION +
    '也可以给 workspace_path（本会话工作区里的文件），直接把工作区文件发出，不必重复内容；' +
    '长文或需要反复修改的产物，建议先用 workspace_write 落盘再发送。';

/** The delivery name of a workspace path: its basename, sanitized like a normal file name */
const deliveryNameOf = (workspacePath: string): string => {
    const sanitized = sanitizeFileName(baseNameOf(workspacePath));
    return sanitized.ok ? sanitized.name : 'file.txt';
};

const inputSchemaOf = (workspace: boolean): Readonly<Record<string, unknown>> => ({
    type: 'object',
    properties: {
        file_name: {
            type: 'string',
            description: '文件名，含扩展名，如 SKILL.md、data.csv、main.ts；workspace_path 模式可省略（用工作区文件名）。',
        },
        content: {
            type: 'string',
            description: '文件的 UTF-8 文本内容；append=true 时是追加的一段；workspace_path 模式不要传。',
        },
        append: {
            type: 'boolean',
            description: 'true=追加到本次回复已写的文件末尾；省略或 false=新建。',
        },
        caption: {
            type: 'string',
            description: '随文件发出的配文；不需要就省略。',
        },
        ...(workspace
            ? {
                  workspace_path: {
                      type: 'string',
                      description:
                          '本会话工作区里的文件路径（如 reports/q3.md）；传了它就不要传 content。',
                  },
                  workspace: {
                      type: 'string',
                      description:
                          '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
                  },
              }
            : {}),
    },
    required: [],
});

export interface SendFileToolOptions {
    readonly state: ReplyMediaState;
    /** The workspace tools are offered this turn; null = `workspace_path` unavailable */
    readonly workspace?: WorkspaceState | null;
    /** Test hook; the production cap is FILE_MAX_BYTES */
    readonly maxBytes?: number;
}

/** The rejection reason gets its own line: tool logs keep counts only */
const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[send_file] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return imageToolError(message);
};

export const createSendFileTool = (options: SendFileToolOptions): ToolHandler => {
    const { state } = options;
    const workspace = options.workspace ?? null;
    const maxBytes = options.maxBytes ?? FILE_MAX_BYTES;

    return {
        definition: {
            name: SEND_FILE_TOOL_NAME,
            description: workspace === null ? BASE_DESCRIPTION : WORKSPACE_DESCRIPTION,
            inputSchema: inputSchemaOf(workspace !== null),
        },
        statusText: '📄 正在写文件…',
        chatAction: 'upload_document',
        execute: async (rawArgs) => {
            if (state.hasReplyImage || state.hasReplySticker || state.hasReplyWidget) {
                return reject(ONE_ATTACHMENT_PER_REPLY);
            }

            const parsed = parseSendFileArgs(rawArgs, { workspace: workspace !== null });
            if (!parsed.ok) return reject(parsed.error);
            const args = parsed.args;

            // A workspace file is a complete file: it cannot be appended to.
            if (args.mode === 'workspace') {
                const existing = state.fileDraft;
                if (existing) {
                    return reject(
                        `这条回复已经有一个文件《${existing.name}》了，每条回复只能发一个文件。`
                    );
                }
                if (workspace === null) {
                    return reject('工作区工具当前没有开启，不能从工作区取文件。');
                }
                const ref = resolveWorkspaceRef(workspace, rawArgs.workspace);
                if (!ref.ok) return reject(ref.error);
                const file = await readWorkspaceFile(workspace.chatId, ref.ref.rootId, args.workspacePath);
                if (file === null) {
                    return reject(
                        `工作区里没有《${args.workspacePath}》。用 workspace_list 看看现有文件，或先 workspace_write 创建。`
                    );
                }
                await touchWorkspaceFile(file.id).catch((error: unknown) => {
                    console.warn('[send_file] workspace lastUsedAt refresh failed:', error);
                });
                const bytes = Buffer.byteLength(file.content, 'utf8');
                if (bytes > maxBytes) {
                    return reject(
                        `工作区文件《${args.workspacePath}》有 ${formatBytes(bytes)}，超过单份上限 ${formatBytes(maxBytes)}；` +
                            '请精简后再发，或拆成多个文件。'
                    );
                }
                const draft: ReplyFileDraft = {
                    name: args.fileName ?? deliveryNameOf(args.workspacePath),
                    mimeType: file.mimeType,
                    parts: [file.content],
                    fromWorkspace: true,
                    ...(args.caption.trim() === '' ? {} : { caption: args.caption }),
                };
                state.fileDraft = draft;
                state.hasReplyFile = true;
                return {
                    content:
                        `已从工作区读出《${args.workspacePath}》：${formatBytes(bytes)}，` +
                        `会作为《${draft.name}》附在这条回复最后发出。`,
                    isError: false,
                    images: [],
                    files: [fileDeliveryOf(draft)],
                    record: null,
                };
            }

            // Inline mode: the model writes the bytes itself (one file per reply).
            const existing = state.fileDraft;
            if (args.append) {
                if (!existing) {
                    return reject('还没有文件可以追加：第一次调用不要带 append。');
                }
                if (existing.fromWorkspace === true) {
                    return reject(
                        '这个文件是从工作区取出的完整内容，不能再追加；要改内容请先改工作区文件，再重新从工作区发一次。'
                    );
                }
                if (existing.name !== args.fileName) {
                    return reject(
                        `要追加的文件是《${existing.name}》，但这次 file_name 是《${args.fileName}》；` +
                            '追加时 file_name 要与第一次一致。'
                    );
                }
            } else if (existing) {
                return reject(
                    `这条回复已经有一个文件《${existing.name}》了，每条回复只能发一个文件；` +
                        '补充内容请用 append=true。'
                );
            }

            const addedBytes = Buffer.byteLength(args.content, 'utf8');
            const currentBytes = existing === undefined ? 0 : fileDraftBytes(existing);
            if (currentBytes + addedBytes > maxBytes) {
                return reject(
                    `内容太大：这次 ${formatBytes(addedBytes)}，整份文件上限 ${formatBytes(maxBytes)}` +
                        `（当前已写 ${formatBytes(currentBytes)}），请精简或拆成更小的文件。`
                );
            }

            const draft = existing ?? {
                name: args.fileName,
                mimeType: args.mimeType,
                parts: [] as string[],
            };
            draft.parts.push(args.content);
            // The first caption wins; later calls cannot rewrite what is already set
            if (draft.caption === undefined && args.caption.trim() !== '') {
                draft.caption = args.caption;
            }
            state.fileDraft = draft;
            state.hasReplyFile = true;

            const totalBytes = fileDraftBytes(draft);
            return {
                content: args.append
                    ? `已追加 ${formatBytes(addedBytes)}，《${draft.name}》当前 ${formatBytes(totalBytes)}` +
                      `（上限 ${formatBytes(maxBytes)}）。`
                    : `文件《${draft.name}》已写好：${formatBytes(totalBytes)}（上限 ${formatBytes(maxBytes)}），` +
                      '会附在这条回复最后发出；如果还有后续内容，用 append=true 继续追加。',
                isError: false,
                images: [],
                files: [fileDeliveryOf(draft)],
                record: null,
            };
        },
    };
};
