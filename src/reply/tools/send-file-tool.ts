/**
 * send_file: the model writes a text file and the reply delivers it as a
 * Telegram document.
 *
 * The tool only assembles the content. Delivery happens after the reply text,
 * in the same branch as the image and sticker paths, so stop, retry, failure
 * fallback and version switching work for a file exactly as they do for a
 * picture. One file per reply: a second name is refused, appending continues
 * the same file.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { FILE_MAX_BYTES, formatBytes, parseSendFileArgs } from './file-tool-args.js';
import { imageToolError } from './image-tool-result.js';
import {
    ONE_ATTACHMENT_PER_REPLY,
    fileDeliveryOf,
    fileDraftBytes,
    type ReplyMediaState,
} from './reply-media-state.js';
import { SEND_FILE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '把你写的文本内容作为文件发到聊天（附在当前回复末尾，每条回复最多一个附件）。' +
    '适合装不进一条消息的成品长文：完整的 SKILL.md、代码文件、CSV/JSON 数据、报告等。' +
    '文件名由你决定，保留扩展名；内容是 UTF-8 文本；单份上限 10 MB，' +
    '可分多次调用用 append=true 追加。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        file_name: {
            type: 'string',
            description: '文件名，含扩展名，如 SKILL.md、data.csv、main.ts',
        },
        content: {
            type: 'string',
            description: '文件的 UTF-8 文本内容；append=true 时是追加的一段',
        },
        append: {
            type: 'boolean',
            description: 'true=追加到本次回复已写的文件末尾；省略或 false=新建',
        },
        caption: {
            type: 'string',
            description: '随文件发出的配文；不需要就省略。',
        },
    },
    required: ['file_name', 'content'],
};

export interface SendFileToolOptions {
    readonly state: ReplyMediaState;
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
    const maxBytes = options.maxBytes ?? FILE_MAX_BYTES;

    return {
        definition: {
            name: SEND_FILE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📄 正在写文件…',
        chatAction: 'upload_document',
        execute: async (rawArgs) => {
            if (state.hasReplyImage || state.hasReplySticker || state.hasReplyWidget) {
                return reject(ONE_ATTACHMENT_PER_REPLY);
            }

            const parsed = parseSendFileArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const args = parsed.args;

            const existing = state.fileDraft;
            if (args.append) {
                if (!existing) {
                    return reject('还没有文件可以追加：第一次调用不要带 append。');
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
