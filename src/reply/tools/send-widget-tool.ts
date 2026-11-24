/**
 * send_widget: put one chat UI card into the reply as its attachment.
 *
 * The model decides whether the conversation wants a card — the tool only
 * describes what it can build and the two shapes. A2UI mode is the everyday
 * one: the model writes a small component surface and the server compiles it
 * into widget HTML, so the model never writes CSS/JS. HTML mode is the escape
 * hatch, allowed only when WIDGET_ALLOW_HTML=1.
 *
 * One attachment per reply: this shares the image/sticker/file flag, so a reply
 * cannot send a picture and a card, or two cards.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { compileA2uiSurface } from '../../ai/widget/index.js';
import { imageToolError } from './image-tool-result.js';
import { ONE_ATTACHMENT_PER_REPLY, type ReplyMediaState } from './reply-media-state.js';
import { SEND_WIDGET_TOOL_NAME } from './tool-names.js';
import {
    precheckWidgetHtml,
    widgetDeliveryOf,
    type WidgetPrecheckLimits,
} from '../../telegram/widget-precheck.js';
import { normalizeWorkspacePath, readWorkspaceFile, touchWorkspaceFile } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { traceBytes, traceParts } from './tool-trace.js';

const BASE_DESCRIPTION =
    '发送 UI 卡片（1附件/回复，不可改）。' +
    "先 load_skill(['widget-a2ui']) 或 load_skill(['widget-html']) 读规范；a2ui 传 JSON，html 需开启。";

const WORKSPACE_DESCRIPTION =
    BASE_DESCRIPTION +
    '支持 workspace_path（发前先 workspace(action="preview")）。';

const inputSchemaOf = (workspace: boolean): Readonly<Record<string, unknown>> => ({
    type: 'object',
    properties: {
        mode: {
            type: 'string',
            enum: ['a2ui', 'html'],
            description: 'a2ui（推荐）/ html（需开启）',
        },
        surface: {
            // A JSON object argument loses its nested fields on some platforms
            // (harness issue #5); the tool takes the surface as a JSON string.
            type: 'string',
            description: 'a2ui 必填：minified JSON（见 widget-a2ui）',
        },
        html: {
            type: 'string',
            description: 'html 必填：自包含 HTML（无外链）',
        },
        caption: {
            type: 'string',
            description: '卡片配文',
        },
        ...(workspace
            ? {
                  workspace_path: {
                      type: 'string',
                      description: '工作区路径（与 html/surface 互斥）',
                  },
                  workspace: {
                      type: 'string',
                      description: '工作区（省=w1）',
                  },
              }
            : {}),
    },
    required: ['mode'],
});

export interface SendWidgetToolOptions {
    readonly state: ReplyMediaState;
    readonly limits: WidgetPrecheckLimits;
    /** The workspace tools are offered this turn; null = `workspace_path` unavailable */
    readonly workspace?: WorkspaceState | null;
}

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(
        `[send_widget] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`
    );
    return imageToolError(message);
};

const modeOf = (raw: unknown): 'a2ui' | 'html' | null =>
    raw === 'a2ui' || raw === 'html' ? raw : null;

const captionOf = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;

/**
 * The surface as the version stores it: the tool takes a JSON string (issue
 * #5), while a later context replays it as JSON. Parsing here keeps the stored
 * value the same whether the model passed a string or an object.
 */
const surfaceForStorage = (raw: unknown): unknown => {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};

const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

export const createSendWidgetTool = (options: SendWidgetToolOptions): ToolHandler => {
    const { state, limits } = options;
    const workspace = options.workspace ?? null;

    return {
        definition: {
            name: SEND_WIDGET_TOOL_NAME,
            description: workspace === null ? BASE_DESCRIPTION : WORKSPACE_DESCRIPTION,
            inputSchema: inputSchemaOf(workspace !== null),
        },
        statusText: '🧩 正在准备卡片…',
        execute: async (rawArgs) => {
            if (state.hasReplyImage || state.hasReplySticker || state.hasReplyFile || state.hasReplyWidget) {
                return reject(ONE_ATTACHMENT_PER_REPLY);
            }
            const mode = modeOf(rawArgs.mode);
            if (mode === null) {
                return reject('mode 必须是 "a2ui" 或 "html"。');
            }
            const caption = captionOf(rawArgs.caption);

            // A workspace file may supply the html / surface payload.
            let htmlArg = rawArgs.html;
            let surfaceArg = rawArgs.surface;
            const rawWorkspacePath = rawArgs.workspace_path;
            const fromWorkspace = !isAbsent(rawWorkspacePath);
            const traceArgument = traceParts(mode, fromWorkspace ? '工作区' : null);
            if (!isAbsent(rawWorkspacePath)) {
                if (workspace === null) {
                    return reject('工作区工具当前没有开启，不能从工作区取卡片内容。');
                }
                if (!isAbsent(rawArgs.html) || !isAbsent(rawArgs.surface)) {
                    return reject('workspace_path 和 html/surface 只能给一个：从工作区取内容时不要再传 html/surface。');
                }
                if (typeof rawWorkspacePath !== 'string' || rawWorkspacePath.trim() === '') {
                    return reject('参数有误：workspace_path 要传工作区里的相对路径。');
                }
                const normalized = normalizeWorkspacePath(rawWorkspacePath);
                if (!normalized.ok) return reject(normalized.error);
                const ref = resolveWorkspaceRef(workspace, rawArgs.workspace);
                if (!ref.ok) return reject(ref.error);
                const file = await readWorkspaceFile(workspace.chatId, ref.ref.rootId, normalized.path);
                if (file === null) {
                    return reject(
                        `工作区里没有《${normalized.path}》。用 workspace(action="list") 看看现有文件，或先 workspace(action="write") 创建。`
                    );
                }
                await touchWorkspaceFile(file.id).catch((error: unknown) => {
                    console.warn('[send_widget] workspace lastUsedAt refresh failed:', error);
                });
                if (mode === 'a2ui') surfaceArg = file.content;
                else htmlArg = file.content;
            } else if (rawArgs.workspace !== undefined && rawArgs.workspace !== null && rawArgs.workspace !== '') {
                return reject('workspace 只用于 workspace_path 模式；要发工作区里的卡片请传 workspace_path。');
            }

            if (mode === 'a2ui') {
                if (surfaceArg === undefined || surfaceArg === null) {
                    return reject("mode=\"a2ui\" 需要 surface（A2UI surface JSON）；先 load_skill(['widget-a2ui']) 查看形状。");
                }
                const compiled = compileA2uiSurface(surfaceArg, {
                    maxHtmlBytes: limits.maxHtmlBytes,
                    maxGzipBytes: limits.maxGzipBytes,
                });
                if (!compiled.ok) {
                    return reject(`A2UI 编译失败：${compiled.message}`);
                }
                const checked = precheckWidgetHtml('a2ui', compiled.html, limits);
                if (!checked.ok) {
                    return reject(`编译产物未通过预检：${checked.message}`);
                }
                const widget = widgetDeliveryOf('a2ui', compiled.html, caption, surfaceForStorage(surfaceArg));
                state.widget = widget;
                state.hasReplyWidget = true;
                const traceResult =
                    `卡片 ${traceBytes(checked.size.rawBytes)}` +
                    `（zlib ${traceBytes(checked.size.zlibBytes)}）`;
                return {
                    content:
                        `已准备卡片（a2ui，raw ${checked.size.rawBytes}B / 压缩后 ${checked.size.zlibBytes}B），` +
                        '会附在这条回复末尾发出；旧版客户端只显示 caption 文字。' +
                        (caption ? `caption：${caption}` : ''),
                    isError: false,
                    images: [],
                    widgets: [widget],
                    record: null,
                    trace: { argument: traceArgument, result: traceResult },
                };
            }

            const htmlRaw = htmlArg;
            if (typeof htmlRaw !== 'string' || htmlRaw.trim().length === 0) {
                return reject('mode="html" 需要 html（完整自包含 HTML 字符串）。');
            }
            const checked = precheckWidgetHtml('html', htmlRaw, limits);
            if (!checked.ok) {
                return reject(checked.message);
            }
            const widget = widgetDeliveryOf('html', htmlRaw, caption, undefined);
            state.widget = widget;
            state.hasReplyWidget = true;
            const traceResult =
                `卡片 ${traceBytes(checked.size.rawBytes)}（zlib ${traceBytes(checked.size.zlibBytes)}）`;
            return {
                content:
                    `已准备卡片（html，raw ${checked.size.rawBytes}B / 压缩后 ${checked.size.zlibBytes}B），` +
                    '会附在这条回复末尾发出；旧版客户端只显示 caption 文字。' +
                    (caption ? `caption：${caption}` : ''),
                isError: false,
                images: [],
                widgets: [widget],
                record: null,
                trace: { argument: traceArgument, result: traceResult },
            };
        },
    };
};
