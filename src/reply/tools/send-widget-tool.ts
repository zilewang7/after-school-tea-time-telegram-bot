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

const DESCRIPTION =
    '把一张聊天内 UI 卡片作为这条回复的附件发到聊天（每条回复最多一个附件）。' +
    '先用 get_ui_guide 取对应模式的完整规范。' +
    'mode="a2ui"：日常信息卡（卡片/文本/列表/表格/图表/按钮视觉），传 A2UI 子集 surface JSON；服务端编译成卡片，体积小、样式稳定。' +
    'mode="html"：声明式组件表达不了的自定义视觉/动效，传一份自包含 HTML（需服务端开启 HTML 模式）。' +
    '可选 caption 显示在卡片下方。卡片发出后不可修改。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        mode: {
            type: 'string',
            enum: ['a2ui', 'html'],
            description: 'a2ui=组件 JSON（推荐）；html=自包含 HTML（需开启）',
        },
        surface: {
            description:
                'mode=a2ui 时必填：A2UI v1.0 surface（JSON 对象或字符串），形状见 get_ui_guide(kind="a2ui")',
        },
        html: {
            type: 'string',
            description: 'mode=html 时必填：一份自包含 HTML（inline CSS/JS，无外链）',
        },
        caption: {
            type: 'string',
            description: '显示在卡片下方的说明文字；不需要就省略',
        },
    },
    required: ['mode'],
};

export interface SendWidgetToolOptions {
    readonly state: ReplyMediaState;
    readonly limits: WidgetPrecheckLimits;
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

export const createSendWidgetTool = (options: SendWidgetToolOptions): ToolHandler => {
    const { state, limits } = options;

    return {
        definition: {
            name: SEND_WIDGET_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
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

            if (mode === 'a2ui') {
                if (rawArgs.surface === undefined || rawArgs.surface === null) {
                    return reject('mode="a2ui" 需要 surface（A2UI surface JSON）；先 get_ui_guide(kind="a2ui") 查看形状。');
                }
                const compiled = compileA2uiSurface(rawArgs.surface, {
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
                state.widget = widgetDeliveryOf('a2ui', compiled.html, caption, rawArgs.surface);
                state.hasReplyWidget = true;
                return {
                    content:
                        `已准备卡片（a2ui，raw ${checked.size.rawBytes}B / 压缩后 ${checked.size.zlibBytes}B），` +
                        '会附在这条回复末尾发出；旧版客户端只显示 caption 文字。' +
                        (caption ? `caption：${caption}` : ''),
                    isError: false,
                    images: [],
                    record: null,
                };
            }

            const htmlRaw = rawArgs.html;
            if (typeof htmlRaw !== 'string' || htmlRaw.trim().length === 0) {
                return reject('mode="html" 需要 html（完整自包含 HTML 字符串）。');
            }
            const checked = precheckWidgetHtml('html', htmlRaw, limits);
            if (!checked.ok) {
                return reject(checked.message);
            }
            state.widget = widgetDeliveryOf('html', htmlRaw, caption, undefined);
            state.hasReplyWidget = true;
            return {
                content:
                    `已准备卡片（html，raw ${checked.size.rawBytes}B / 压缩后 ${checked.size.zlibBytes}B），` +
                    '会附在这条回复末尾发出；旧版客户端只显示 caption 文字。' +
                    (caption ? `caption：${caption}` : ''),
                isError: false,
                images: [],
                record: null,
            };
        },
    };
};
