/**
 * get_ui_guide: the on-demand authoring spec for chat UI cards.
 *
 * The full widget/A2UI authoring guides are far too long to keep in the system
 * prompt or a tool description — they would add context to every single reply
 * and break the byte-stable prompt prefix. The model fetches one only after it
 * decides a card is worth building, then calls send_widget. Progressive
 * disclosure, same idea as a skill/guide registry; when more large specs appear
 * this tool is the place to generalise.
 */
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { getWidgetGuide } from '../../ai/widget/guides/index.js';
import { imageToolError } from './image-tool-result.js';
import { GET_UI_GUIDE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '取生成聊天内 UI 卡片的完整写作规范。决定要用 send_widget 之前先调用一次：' +
    'kind="a2ui" 取 A2UI 子集组件规范（日常卡片/表格/图表）；' +
    'kind="html" 取完整 HTML 卡片规范（仅在服务端开启 HTML 模式时需要）。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        kind: {
            type: 'string',
            enum: ['a2ui', 'html'],
            description: 'a2ui=组件 JSON 规范；html=完整 HTML 规范',
        },
    },
    required: ['kind'],
};

const kindOf = (raw: unknown): 'a2ui' | 'html' | null =>
    raw === 'a2ui' || raw === 'html' ? raw : null;

export const createUiGuideTool = (): ToolHandler => ({
    definition: {
        name: GET_UI_GUIDE_TOOL_NAME,
        description: DESCRIPTION,
        inputSchema: INPUT_SCHEMA,
    },
    statusText: '📖 正在取规范…',
    execute: async (rawArgs) => {
        const kind = kindOf(rawArgs.kind);
        if (kind === null) {
            return imageToolError('kind 必须是 "a2ui" 或 "html"。');
        }
        const guide = getWidgetGuide(kind);
        return {
            content: `[${guide.kind} guide · version ${guide.version}]\n\n${guide.text}`,
            isError: false,
            images: [],
            record: null,
        };
    },
});
